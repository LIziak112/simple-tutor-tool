/**
 * 学生端 AI 伴学服务层性能采样（B18 SAI-33 第 6 条；手动工具，不进 CI）：
 * `node node_modules/tsx/dist/cli.mjs scripts/student-ai-bench.ts`（apps/server 下）。
 *
 * 同一合成世界（内存库 + 1 学生 + 两题作答）测三个维度，输出「有无 AI」对照：
 * ① 作答保存延迟：saveDraftAnswer 300 次的 p50/p95/max——无 AI 基线 vs
 *    「同学生 20 个待派发任务 + 一轮 worker 派发出站挂起中」两个分布
 *    （红线：出站 fetch 在事务外，保存不得被同步编码阻塞）；
 * ② 长稿编码与内存：assembleOutboundMessages 对 120KB 题面 + 120KB 解析 +
 *    10 条历史 + 2 份材料引用装配 50 次的单次耗时与堆增量（仅 AI 侧存在的
 *    路径，无「无 AI」对照，对照维度是①）；
 * ③ 积压处理：6 学生 × 10 任务 = 60 积压，瞬时回信 transport 下
 *    runStudentAiDispatchOnce 逐轮排空的总耗时与吞吐（全局 20 / 每学生 3
 *    并发的负载整形口径，幂次与上限是设计值非缺陷）。
 *
 * 采样波动如实记录：内存数字未强制 GC（Node 默认），单机单次运行仅作量级
 * 参考；机器与数据规模随输出打印。业务语义断言（保存成功、任务 replied）
 * 内联为防呆检查，失败即抛——不给出无意义数字。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Db } from "../src/db/client.ts";
import { createTestDb, TEST_TEACHER_ID } from "../src/db/test-utils.ts";
import { createStudentAiConnection } from "../src/services/ai-companion/connection-service.ts";
import {
  type AiOutboundMaterialRef,
  assembleOutboundMessages,
  systemPromptOfSnapshotMd,
} from "../src/services/ai-companion/student-ai-context.ts";
import { createAiTask } from "../src/services/ai-companion/student-ai-queue.ts";
import {
  runStudentAiDispatchOnce,
  type StudentAiDispatchRunSummary,
} from "../src/services/ai-companion/student-ai-worker.ts";
import { saveDraftAnswer } from "../src/services/attempt-service.ts";
import {
  insertAttempt,
  insertResponse,
} from "../src/test/ai-companion-fixtures.ts";
import { makeStudent } from "../src/test/note-fixtures.ts";

// ---------- 常量与工具 ----------

/** 采样规模（保存次数 / 长稿装配次数 / 积压任务数：每生待处理上限 10） */
const SAVE_ROUNDS = 300;
const ASSEMBLY_ROUNDS = 50;
const BACKLOG_TASKS_PER_STUDENT = 10;
const BACKLOG_STUDENTS = 6;

const ROOT_SECRET = "22".repeat(32);
const HMAC_SECRET = "bench-secret-0001";
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const DATA_DIR = mkdtempSync(join(tmpdir(), "tutor-sai-bench-"));

/** 瞬时回信体（与 worker 测试同形态的 OpenAI 兼容最小响应） */
const OK_BODY = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "BENCH-REPLY" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

function pct(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? 0;
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return `avg=${(total / samples.length).toFixed(2)}ms p50=${pct(sorted, 0.5).toFixed(2)}ms p95=${pct(sorted, 0.95).toFixed(2)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms n=${samples.length}`;
}

/** 防呆：派发摘要应全部回信成功（脚本数字只在业务语义成立时有效） */
function assertAllReplied(summary: StudentAiDispatchRunSummary): void {
  if (summary.replied !== summary.dispatched || summary.failed > 0) {
    throw new Error(
      `派发未全部成功：${JSON.stringify(summary)}（数字无效，先修语义）`,
    );
  }
}

// ---------- 世界构造 ----------

interface World {
  readonly db: Db;
  readonly studentId: string;
  readonly attemptId: string;
}

function makeWorld(): World {
  const db = createTestDb();
  const studentId = makeStudent(db, TEST_TEACHER_ID);
  const attemptId = insertAttempt(db, { studentId });
  insertResponse(db, attemptId, "q1");
  insertResponse(db, attemptId, "q2");
  return { db, studentId, attemptId };
}

function addInappConnection(db: Db, studentId: string): void {
  createStudentAiConnection(db, {
    studentId,
    rootSecret: ROOT_SECRET,
    request: {
      channel: "inapp",
      baseUrl: "http://api.bench-provider.test/v1",
      model: "bench-model",
      apiKey: "sk-bench-key-123",
      isDefault: true,
      imageCapability: "unknown",
    },
  });
}

function mkTask(
  db: Db,
  studentId: string,
  attemptId: string,
  at: number,
  questionId = "q1",
): string {
  return createAiTask(
    db,
    {
      studentId,
      attemptId,
      questionId,
      question: "基准采样求助",
      channel: "inapp",
      mutationId: `bench-mut-${at}-${Math.random().toString(36).slice(2, 8)}`,
    },
    { hmacSecret: HMAC_SECRET, now: new Date(T0 + at) },
  ).task.id;
}

/** 保存延迟采样：交替判断对/错各存一次（每次真实走事务与 upsert） */
function sampleSaveLatency(world: World): number[] {
  const samples: number[] = [];
  for (let i = 0; i < SAVE_ROUNDS; i++) {
    const answer = { kind: "judge" as const, value: i % 2 === 0 };
    const t0 = performance.now();
    saveDraftAnswer(world.db, world.studentId, world.attemptId, "q2", answer);
    samples.push(performance.now() - t0);
  }
  return samples;
}

// ---------- 维度①：作答保存延迟（无 AI vs 派发挂起中） ----------

async function benchSaveLatency(): Promise<World> {
  const world = makeWorld();
  const baseline = sampleSaveLatency(world);
  console.log(`①-A 保存延迟·无 AI 基线：${stats(baseline)}`);

  // 有 AI 侧：同题 3 个任务（每题进行中任务上限，即真实最大在途），一轮
  // 派发出站被门闩挂起（begin 事务已落库、fetch 在途）——窗口内跑同一保存采样
  addInappConnection(world.db, world.studentId);
  for (let i = 0; i < 3; i++)
    mkTask(world.db, world.studentId, world.attemptId, i);
  let openGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const heldTransport = async () => {
    await gate;
    return { status: 200, headers: {}, bodyText: OK_BODY };
  };
  const round = runStudentAiDispatchOnce(world.db, {
    dataDir: DATA_DIR,
    rootSecret: ROOT_SECRET,
    transport: heldTransport,
    now: () => new Date(T0 + 1000),
  });
  // 门闩释放前 worker 的出站在途：此刻采样保存（每学生并发上限 3 在途）
  const withAi = sampleSaveLatency(world);
  openGate?.();
  assertAllReplied(await round);
  console.log(`①-B 保存延迟·派发在途（3 出站挂起）：${stats(withAi)}`);
  return world;
}

// ---------- 维度②：长稿编码与内存 ----------

function benchLongDocAssembly(): void {
  const para =
    "本段为合成长题面文本，包含中文与公式 $x^2+y^2$ 的混合排版；".repeat(40);
  const stemMd = para.repeat(Math.ceil((120 * 1024) / para.length));
  const solutionMd = stemMd.replace(/题面/g, "解析");
  const promptSnapshotMd = "基准提示词快照：请以启发模式讲解本题。";
  const snapshot = {
    questionRevisionId: "bench-rev-0001",
    questionId: "q1",
    questionType: "judge",
    stemMd,
    knowledgePoints: ["有理数的概念"],
    difficulty: 3,
    studentAnswerText: "正确",
    referenceAnswerMd: "正确",
    solutionMd,
    missingNote: null,
    promptSnapshotMd,
    capturedAt: "2026-06-01T00:00:00.000Z",
  };
  const history = Array.from({ length: 10 }, (_, i) => ({
    id: `bench-msg-${i}`,
    taskId: "bench-task",
    role: (i % 2 === 0 ? "student" : "assistant") as "student" | "assistant",
    contentMd: para.slice(0, 2048),
    createdAt: new Date(T0 + i * 1000).toISOString(),
  }));
  const materials: AiOutboundMaterialRef[] = [
    { kind: "draft" as const, pageIndex: 0, byteSize: 82_000 },
    { kind: "annotation" as const, pageIndex: 0, byteSize: 78_000 },
  ];

  const samples: number[] = [];
  const before = process.memoryUsage();
  let payloadBytes = 0;
  for (let i = 0; i < ASSEMBLY_ROUNDS; i++) {
    const t0 = performance.now();
    const assembly = assembleOutboundMessages({
      bundle: {
        snapshot,
        systemPromptMd: systemPromptOfSnapshotMd(promptSnapshotMd),
      },
      studentQuestion: "请帮我讲解本题",
      history,
      materials,
    });
    payloadBytes = JSON.stringify(assembly).length;
    samples.push(performance.now() - t0);
  }
  const after = process.memoryUsage();
  console.log(
    `② 长稿编码：题面=${(stemMd.length / 1024).toFixed(0)}KB 解析=${(solutionMd.length / 1024).toFixed(0)}KB 历史=10条 材料=2份 出站载荷=${(payloadBytes / 1024).toFixed(0)}KB`,
  );
  console.log(
    `② 单次装配：${stats(samples)}（含 JSON.stringify；堆增量 ${((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(1)}MB、rss 增量 ${((after.rss - before.rss) / 1024 / 1024).toFixed(1)}MB，未强制 GC）`,
  );
}

// ---------- 维度③：积压处理 ----------

async function benchBacklog(): Promise<void> {
  const db = createTestDb();
  for (let s = 0; s < BACKLOG_STUDENTS; s++) {
    const studentId = makeStudent(db, TEST_TEACHER_ID);
    const attemptId = insertAttempt(db, { studentId });
    addInappConnection(db, studentId);
    // 每题进行中任务上限 3：每生 20 个待处理任务分散在 20 道题上（每题 1 个）
    for (let i = 0; i < BACKLOG_TASKS_PER_STUDENT; i++) {
      insertResponse(db, attemptId, `q${i + 1}`);
      mkTask(db, studentId, attemptId, i, `q${i + 1}`);
    }
  }
  const instantTransport = async () => ({
    status: 200,
    headers: {},
    bodyText: OK_BODY,
  });
  const total = BACKLOG_STUDENTS * BACKLOG_TASKS_PER_STUDENT;
  const perRound: number[] = [];
  const t0 = performance.now();
  for (;;) {
    const summary = await runStudentAiDispatchOnce(db, {
      dataDir: DATA_DIR,
      rootSecret: ROOT_SECRET,
      transport: instantTransport,
      now: () => new Date(T0 + 5000 + perRound.length * 1000),
    });
    if (summary.dispatched === 0) break;
    assertAllReplied(summary);
    perRound.push(summary.dispatched);
    if (perRound.length > 100) throw new Error("排空轮次异常（数字无效）");
  }
  const wallMs = performance.now() - t0;
  const drained = perRound.reduce((sum, value) => sum + value, 0);
  console.log(
    `③ 积压处理：${total} 任务（${BACKLOG_STUDENTS} 学生 × ${BACKLOG_TASKS_PER_STUDENT}）瞬时回信 transport 排空`,
  );
  console.log(
    `③ 总耗时=${wallMs.toFixed(0)}ms 轮次=${perRound.length}（每轮派发 ${perRound.join("/")}，全局≤20/每学生≤3 整形）吞吐=${(drained / (wallMs / 1000)).toFixed(1)} 任务/秒`,
  );
  if (drained !== total) {
    throw new Error(`排空数量不符：${drained}/${total}（数字无效）`);
  }
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  const os = await import("node:os");
  const cpus = os.cpus();
  console.log(
    `机器：${os.platform()} ${os.release()} | ${cpus.length}× ${cpus[0]?.model ?? "?"} | 内存 ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB | Node ${process.version}`,
  );
  console.log(
    `数据规模：保存 ${SAVE_ROUNDS} 次/相 | 长稿装配 ${ASSEMBLY_ROUNDS} 次 | 积压 ${BACKLOG_STUDENTS}×${BACKLOG_TASKS_PER_STUDENT} 任务（内存库）`,
  );
  await benchSaveLatency();
  benchLongDocAssembly();
  await benchBacklog();
  console.log("采样完成（单次运行，量级参考；波动见脚本头注）");
  // 采样世界的落盘（材料/票据）全在临时目录：结束即清，不留残留
  rmSync(DATA_DIR, { recursive: true, force: true });
}

await main();
