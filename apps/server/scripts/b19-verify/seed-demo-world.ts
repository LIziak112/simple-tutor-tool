/**
 * B19 核对脚本试跑用合成世界种子（SAI-34；手动工具，不进 CI）。
 *
 * 用途：在动手核对真实部署的 DATA_DIR 之前，先在临时目录生成一个「真实
 * 服务写出的合成世界」（教师/学生/两题作答/inapp 连接/带材料任务/一轮真实
 * 派发回信/link 票据与两次读取留痕），用 materials-check 与 trace-audit 对
 * 它试跑，熟悉输出与退出码。全部数据为合成/匿名材料，绝不触碰用户
 * DATA_DIR；目录打印出来后手动删除即可（或被系统临时目录清理）。
 *
 * 用法（apps/server 目录下）：
 *   node node_modules/tsx/dist/cli.mjs scripts/b19-verify/seed-demo-world.ts
 * 输出：DATA_DIR 与任务 id——随后可执行：
 *   node node_modules/tsx/dist/cli.mjs scripts/b19-verify/materials-check.ts \
 *     --data-dir <输出的 DATA_DIR>
 *   node node_modules/tsx/dist/cli.mjs scripts/b19-verify/trace-audit.ts \
 *     --data-dir <输出的 DATA_DIR>
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfills } from "../../src/db/backfill.ts";
import { createDb, type Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { teachers } from "../../src/db/schema.ts";
import { TEST_TEACHER_ID } from "../../src/db/test-utils.ts";
import { createStudentAiConnection } from "../../src/services/ai-companion/connection-service.ts";
import { attachAiTaskMaterials } from "../../src/services/ai-companion/student-ai-materials.ts";
import {
  createAiTask,
  markReplyDelivered,
} from "../../src/services/ai-companion/student-ai-queue.ts";
import {
  createAiShareTicket,
  recordShareTicketViewed,
  requireShareTicketByToken,
} from "../../src/services/ai-companion/student-ai-share.ts";
import { runStudentAiDispatchOnce } from "../../src/services/ai-companion/student-ai-worker.ts";
import {
  insertAttempt,
  insertResponse,
} from "../../src/test/ai-companion-fixtures.ts";
import { makeNotePng, makeStudent } from "../../src/test/note-fixtures.ts";

const ROOT_SECRET = "44".repeat(32);
const HMAC_SECRET = "b19-seed-secret";
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const OK_BODY = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "B19 种子世界的合成回信" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-b19-demo-"));
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    await seedWorld(db, dataDir);
  } finally {
    // 成功与失败路径都关库：Windows 上句柄未释放会导致临时目录无法立即删除
    db.$client.close();
  }
}

/** 建合成世界并打印试跑指引（由 main 调用；vitest 导入本文件不执行） */
async function seedWorld(db: Db, dataDir: string): Promise<void> {
  runMigrations(db);
  runBackfills(db);
  db.insert(teachers)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const studentId = makeStudent(db, TEST_TEACHER_ID);
  const attemptId = insertAttempt(db, { studentId });
  insertResponse(db, attemptId, "q1");
  insertResponse(db, attemptId, "q2");
  createStudentAiConnection(db, {
    studentId,
    rootSecret: ROOT_SECRET,
    request: {
      channel: "inapp",
      baseUrl: "http://api.b19-seed.test/v1",
      model: "b19-seed-model",
      apiKey: "sk-b19-seed-key",
      isDefault: true,
      imageCapability: "unknown",
    },
  });

  // 任务一（inapp）：带材料 → 真实派发回信 → 学生打开
  const inappTaskId = createAiTask(
    db,
    {
      studentId,
      attemptId,
      questionId: "q1",
      question: "种子世界：请帮我讲解本题",
      channel: "inapp",
      mutationId: `b19-seed-${Date.now()}`,
    },
    { hmacSecret: HMAC_SECRET, now: new Date(T0) },
  ).task.id;
  attachAiTaskMaterials(db, dataDir, {
    studentId,
    taskId: inappTaskId,
    pages: [
      {
        kind: "annotation",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(320, 200, 400),
      },
      {
        kind: "draft",
        pageIndex: 0,
        pixelWidth: 640,
        pixelHeight: 480,
        png: makeNotePng(640, 480, 500),
      },
    ],
  });
  const summary = await runStudentAiDispatchOnce(db, {
    dataDir,
    rootSecret: ROOT_SECRET,
    transport: async () => ({ status: 200, headers: {}, bodyText: OK_BODY }),
    now: () => new Date(T0 + 1000),
  });
  if (summary.replied !== 1) {
    throw new Error(`种子派发未成功：${JSON.stringify(summary)}（世界不完整）`);
  }
  markReplyDelivered(
    db,
    { studentId, taskId: inappTaskId },
    { now: new Date(T0 + 2000) },
  );

  // 任务二（link）：票据生成 + 两次读取留痕（真实时钟起算有效期）
  const linkTaskId = createAiTask(
    db,
    {
      studentId,
      attemptId,
      questionId: "q2",
      question: "种子世界：链接通道求助",
      channel: "link",
      mutationId: `b19-seed-link-${Date.now()}`,
    },
    { hmacSecret: HMAC_SECRET, now: new Date(T0) },
  ).task.id;
  const { token } = createAiShareTicket(
    db,
    { studentId, taskId: linkTaskId },
    { now: new Date() },
  );
  const resolved = requireShareTicketByToken(db, token);
  recordShareTicketViewed(db, resolved, { now: new Date() });
  recordShareTicketViewed(db, resolved, { now: new Date() });

  console.log(`种子世界已生成（合成/匿名数据）：
  DATA_DIR=${dataDir}
  inapp 任务=${inappTaskId}
  link 任务=${linkTaskId}
试跑：
  node node_modules/tsx/dist/cli.mjs scripts/b19-verify/materials-check.ts --data-dir ${dataDir}
  node node_modules/tsx/dist/cli.mjs scripts/b19-verify/trace-audit.ts --data-dir ${dataDir}
用完手动删除整个目录即可。`);
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行——与其余四脚本同款守卫）
if (process.env.VITEST === undefined) {
  await main();
}
