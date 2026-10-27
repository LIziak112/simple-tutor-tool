/**
 * B19 真机核对脚本自证（SAI-34；合成/匿名数据，不冒充真机结果）。
 *
 * 四个核对脚本（scripts/b19-verify/）供用户真机操作后验收平台侧证据使用；
 * 本文件只证明「脚本本身的断言正确、能跑」：
 * - materials-check：真实服务（createAiTask + attachAiTaskMaterials）在临时
 *   DATA_DIR 落盘的合成材料世界全部通过；逐项破坏（截断/改 hash/改尺寸/
 *   缺页/混装/删文件/状态漂移）后逐条报 FAIL；
 * - trace-audit：真实服务产生的任务/消息/事实/票据世界审计零 FAIL；人为制造
 *   不一致（删事实/清列值/计数漂移/伪造状态）后逐条报 FAIL；
 * - mcp-smoke / link-check：node:http 假端点上的配对成功路径与检测路径。
 * 真实设备/账号/外部 AI 的结果一律记待人工，见 B19-真机核对清单.md。
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadonlyDb } from "../../scripts/b19-verify/common.ts";
import { runLinkCheck } from "../../scripts/b19-verify/link-check.ts";
import {
  checkTaskMaterials,
  type MaterialCheckRow,
} from "../../scripts/b19-verify/materials-check.ts";
import { runMcpSmoke } from "../../scripts/b19-verify/mcp-smoke.ts";
import {
  auditTrace,
  type TraceAuditInput,
} from "../../scripts/b19-verify/trace-audit.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { teachers } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { STUDENT_MCP_TOOL_NAMES } from "../mcp/student-server.ts";
import { createStudentAiConnection } from "../services/ai-companion/connection-service.ts";
import { attachAiTaskMaterials } from "../services/ai-companion/student-ai-materials.ts";
import {
  beginInappDispatch,
  createAiTask,
  failInappDispatch,
  markReplyDelivered,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  createAiShareTicket,
  recordShareTicketViewed,
  requireShareTicketByToken,
} from "../services/ai-companion/student-ai-share.ts";
import { runStudentAiDispatchOnce } from "../services/ai-companion/student-ai-worker.ts";
import { insertAttempt, insertResponse } from "./ai-companion-fixtures.ts";
import { makeNotePng, makeStudent } from "./note-fixtures.ts";

// ---------- 合成世界（真实服务落盘；时间基准与 ai-companion-fixtures 同瞬） ----------

const ROOT_SECRET = "33".repeat(32);
const HMAC_SECRET = "b19-verify-secret";
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

/** 瞬时回信体（与 bench/worker 测试同形态的 OpenAI 兼容最小响应） */
const OK_BODY = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "B19-VERIFY-REPLY" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

interface World {
  readonly db: Db;
  readonly dataDir: string;
  readonly studentId: string;
  readonly attemptId: string;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-b19-verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 建一条 inapp 合成连接（两套世界共用；apiKey 为合成值不出网） */
function connectInapp(db: Db, studentId: string): void {
  createStudentAiConnection(db, {
    studentId,
    rootSecret: ROOT_SECRET,
    request: {
      channel: "inapp",
      baseUrl: "http://api.b19-verify.test/v1",
      model: "b19-model",
      apiKey: "sk-b19-key",
      isDefault: true,
      imageCapability: "unknown",
    },
  });
}

/** 建学生 + 两题作答 + inapp 连接（与 student-ai-bench 同骨架；库为内存库） */
function makeWorld(): World {
  const db = createTestDb();
  const studentId = makeStudent(db, TEST_TEACHER_ID);
  const attemptId = insertAttempt(db, { studentId });
  insertResponse(db, attemptId, "q1");
  insertResponse(db, attemptId, "q2");
  connectInapp(db, studentId);
  return { db, dataDir: dir, studentId, attemptId };
}

/**
 * 文件库世界（CLI 子进程自证用）：真实 tutor.db 落在临时 DATA_DIR——与
 * createTestDb 同构（迁移 + 回填 + 测试教师行 + inapp 连接），建完即关连接
 * 释放 WAL，让脚本以只读方式打开。
 */
function makeFileWorld(): World {
  const db = createDb(join(dir, "tutor.db"));
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
  connectInapp(db, studentId);
  return { db, dataDir: dir, studentId, attemptId };
}

function mkTask(
  world: World,
  at: number,
  questionId: string,
  channel: "inapp" | "link" | "mcp" = "inapp",
): string {
  return createAiTask(
    world.db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId,
      question: "B19 合成核对求助",
      channel,
      mutationId: `b19-verify-${at}-${Math.random().toString(36).slice(2, 8)}`,
    },
    { hmacSecret: HMAC_SECRET, now: new Date(T0 + at) },
  ).task.id;
}

/** 给任务附两类材料：圈画 2 页 + 草稿 2 页（真实走校验/写盘/登记全链） */
function attachMaterials(world: World, taskId: string): void {
  attachAiTaskMaterials(world.db, world.dataDir, {
    studentId: world.studentId,
    taskId,
    pages: [
      {
        kind: "annotation",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(320, 200, 400),
      },
      {
        kind: "annotation",
        pageIndex: 1,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(320, 200, 401),
      },
      {
        kind: "draft",
        pageIndex: 0,
        pixelWidth: 640,
        pixelHeight: 480,
        png: makeNotePng(640, 480, 500),
      },
      {
        kind: "draft",
        pageIndex: 1,
        pixelWidth: 640,
        pixelHeight: 480,
        png: makeNotePng(640, 480, 501),
      },
    ],
  });
}

/** 跑一轮瞬时回信派发（真实 dispatched/reply_received 事实与回信消息） */
async function dispatchOnce(world: World): Promise<void> {
  const summary = await runStudentAiDispatchOnce(world.db, {
    dataDir: world.dataDir,
    rootSecret: ROOT_SECRET,
    transport: async () => ({ status: 200, headers: {}, bodyText: OK_BODY }),
    now: () => new Date(T0 + 1000),
  });
  expect(summary.replied).toBe(1);
}

// ---------- materials-check ----------

describe("materials-check（笔迹材料 PNG 完整性核对；合成世界自证）", () => {
  it("真实服务落盘的完整材料世界：零 FAIL，摘要含类别页数", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId);
    expect(rows).toHaveLength(4);
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(report.findings.filter((f) => f.level === "fail")).toEqual([]);
    expect(report.summary.join("\n")).toContain("题面圈画 2 页");
    expect(report.summary.join("\n")).toContain("草稿 2 页");
  });

  it("截断 PNG 文件 → PNG 完整性 FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId);
    truncateSync(join(world.dataDir, rows[0]?.pngPath ?? ""), 40);
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "题面圈画第 1 页文件不是完整合法的 PNG 文档（可能被截断）",
    );
  });

  it("篡改行 hash → 内容寻址不一致 FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId).map((row, i) =>
      i === 0 ? { ...row, hash: "0".repeat(64) } : row,
    );
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "题面圈画第 1 页文件内容 sha-256 与登记值不符（内容寻址被破坏）",
    );
  });

  it("声明尺寸与 PNG 实际不符 → FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId).map((row, i) =>
      i === 2 ? { ...row, pixelWidth: 999 } : row,
    );
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "草稿第 1 页 PNG 实际尺寸 640×480 与登记值 999×480 不符",
    );
  });

  it("缺页（页序缺口）→ FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId).filter(
      (row) => !(row.kind === "draft" && row.pageIndex === 0),
    );
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "草稿的页序不连续（缺第 1 页），长稿可能不完整",
    );
  });

  it("草稿与正式手写混装 → 配对规则 FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId).map((row) =>
      row.kind === "draft" && row.pageIndex === 1
        ? { ...row, kind: "formal_ink" }
        : row,
    );
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "草稿与正式手写同时登记（纸面材料二选一规则被破坏）",
    );
  });

  it("文件缺失 → FAIL 且只报缺失页", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId);
    rmSync(join(world.dataDir, rows[3]?.pngPath ?? ""));
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toEqual([
      "草稿第 2 页材料文件缺失（blobs 路径无对应 PNG）",
    ]);
  });

  it("state 非 ready → FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    const rows = queryMaterialRows(world, taskId).map((row, i) =>
      i === 0 ? { ...row, state: "missing" } : row,
    );
    const report = checkTaskMaterials(world.dataDir, rows);
    expect(failTexts(report.findings)).toContain(
      "题面圈画第 1 页状态为 missing（应为 ready）",
    );
  });
});

// ---------- trace-audit ----------

describe("trace-audit（平台留痕核对；真实服务产生的世界自证）", () => {
  it("真实服务产生的 inapp 全链 + link 票据世界：零 FAIL", async () => {
    const world = makeWorld();
    const inappTaskId = mkTask(world, 0, "q1");
    attachMaterials(world, inappTaskId);
    await dispatchOnce(world);
    markReplyDelivered(
      world.db,
      { studentId: world.studentId, taskId: inappTaskId },
      { now: new Date(T0 + 2000) },
    );

    const linkTaskId = mkTask(world, 3000, "q2", "link");
    // 票据有效期以真实时钟起算（requireShareTicketByToken 按真实时刻校验，
    // 固定 T0 会被判过期），读取留痕同样用真实时刻保持一致
    const { token } = createAiShareTicket(
      world.db,
      { studentId: world.studentId, taskId: linkTaskId },
      { now: new Date() },
    );
    const resolved = requireShareTicketByToken(world.db, token);
    recordShareTicketViewed(world.db, resolved, { now: new Date() });
    recordShareTicketViewed(world.db, resolved, { now: new Date() });

    const report = auditTrace(readTraceInput(world));
    expect(report.findings.filter((f) => f.level === "fail")).toEqual([]);
    const text = report.lines.join("\n");
    expect(text).toContain("task_created");
    expect(text).toContain("dispatched");
    expect(text).toContain("reply_received");
    expect(text).toContain("reply_delivered");
    expect(text).toContain("link_generated");
    expect(text).toContain("link_viewed ×2");
  });

  it("replied 任务被删 reply_received 事实 → FAIL", async () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    await dispatchOnce(world);
    world.db.$client
      .prepare(
        "DELETE FROM ai_facts WHERE task_id = ? AND type = 'reply_received'",
      )
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "任务 replied 但无 reply_received 事实（回信留痕被破坏）",
    );
  });

  it("replyDeliveredAt 清空但 reply_delivered 事实残留 → FAIL（双向对账）", async () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    await dispatchOnce(world);
    markReplyDelivered(
      world.db,
      { studentId: world.studentId, taskId },
      { now: new Date(T0 + 2000) },
    );
    world.db.$client
      .prepare("UPDATE ai_tasks SET reply_delivered_at = NULL WHERE id = ?")
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "任务有 reply_delivered 事实但 reply_delivered_at 列为空（列与事实不对账）",
    );
  });

  it("link 任务未生成票据（两步设计合法态）→ 零 FAIL", () => {
    const world = makeWorld();
    mkTask(world, 0, "q2", "link");
    const report = auditTrace(readTraceInput(world));
    expect(report.findings.filter((f) => f.level === "fail")).toEqual([]);
  });

  it("票据行与 link_generated 事实不成对（删事实）→ FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q2", "link");
    createAiShareTicket(world.db, {
      studentId: world.studentId,
      taskId,
    });
    world.db.$client
      .prepare(
        "DELETE FROM ai_facts WHERE task_id = ? AND type = 'link_generated'",
      )
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "票据行 1 与 link_generated 事实数 0 不成对（票据留痕被破坏）",
    );
  });

  it("票据 viewCount 合计与 link_viewed 事实计数不符 → FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q2", "link");
    const { token } = createAiShareTicket(
      world.db,
      { studentId: world.studentId, taskId },
      { now: new Date() },
    );
    const resolved = requireShareTicketByToken(world.db, token);
    recordShareTicketViewed(world.db, resolved, { now: new Date() });
    world.db.$client
      .prepare("UPDATE ai_share_tickets SET view_count = 5 WHERE task_id = ?")
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "票据读取计数合计 5 与 link_viewed 事实数 1 不符（读取留痕被破坏）",
    );
  });

  it("重新生成票据后各票计数合计仍与事实总数成对（合法态零 FAIL）", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q2", "link");
    const first = createAiShareTicket(world.db, {
      studentId: world.studentId,
      taskId,
    });
    const resolved = requireShareTicketByToken(world.db, first.token);
    recordShareTicketViewed(world.db, resolved, { now: new Date() });
    recordShareTicketViewed(world.db, resolved, { now: new Date() });
    // 旧票未撤销也可再生成新票（重新生成链接语义）：合计 2 = 事实 2
    createAiShareTicket(world.db, { studentId: world.studentId, taskId });
    const report = auditTrace(readTraceInput(world));
    expect(report.findings.filter((f) => f.level === "fail")).toEqual([]);
  });

  it("inapp 真实失败路径（failed 不写 dispatched，SAI-14 口径）→ 零 FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    beginInappDispatch(
      world.db,
      { studentId: world.studentId, taskId },
      { now: new Date(T0 + 500) },
    );
    failInappDispatch(
      world.db,
      {
        studentId: world.studentId,
        taskId,
        generation: 1,
        errorText: "上游 401：Key 无效",
        kind: "retryable",
      },
      { now: new Date(T0 + 600) },
    );
    const report = auditTrace(readTraceInput(world));
    expect(report.findings.filter((f) => f.level === "fail")).toEqual([]);
    const text = report.lines.join("\n");
    expect(text).toContain("failed"); // 时间线如实呈现失败态
    expect(text).not.toContain("dispatched"); // 且不伪造已外发事实
  });

  it("dispatched 事实残留但 generation 被清零 → FAIL（代际对账）", async () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    await dispatchOnce(world);
    world.db.$client
      .prepare(
        "UPDATE ai_tasks SET status = 'created', generation = 0 WHERE id = ?",
      )
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      `任务 ${taskId.slice(0, 8)} 有 dispatched 事实但 generation=0（代际与出站留痕不对账）`,
    );
  });

  it("mcp 任务伪造 claimed 但无 dispatched 事实 → FAIL（领取留痕）", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1", "mcp");
    world.db.$client
      .prepare(
        "UPDATE ai_tasks SET status = 'claimed', generation = 1 WHERE id = ?",
      )
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      `任务 ${taskId.slice(0, 8)} MCP 任务 claimed/replied 但无 dispatched 事实（领取留痕被破坏）`,
    );
  });

  it("failed 任务无 errorText → FAIL", () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    world.db.$client
      .prepare(
        "UPDATE ai_tasks SET status = 'failed', error_text = NULL WHERE id = ?",
      )
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "任务 failed 但 errorText 为空（失败摘要缺失）",
    );
  });

  it("inapp 任务 replied 但 generation 为 0 → FAIL（未出站却有回信）", async () => {
    const world = makeWorld();
    const taskId = mkTask(world, 0, "q1");
    await dispatchOnce(world);
    world.db.$client
      .prepare("UPDATE ai_tasks SET generation = 0 WHERE id = ?")
      .run(taskId);
    const report = auditTrace(readTraceInput(world));
    expect(failTexts(report.findings)).toContain(
      "任务已开始出站（回信/失败/待确认/已领取）但 generation=0",
    );
  });
});

// ---------- mcp-smoke（假端点；只读配对冒烟） ----------

describe("mcp-smoke（MCP 配对冒烟；node:http 假端点自证）", () => {
  let server: Server;
  let baseUrl: string;
  let tools: string[];
  let anonymousPasses: boolean;

  beforeEach(async () => {
    // 假端点工具清单单源（2026-10 评审修复：此前本地四工具字面量，服务端扩到
    // 十工具后该脚本测试与真实清单脱节）
    tools = [...STUDENT_MCP_TOOL_NAMES];
    anonymousPasses = false;
    server = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (
        auth !== "Bearer good-token" &&
        !(auth === undefined && anonymousPasses)
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001 } }));
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        let result: unknown;
        if (parsed.method === "tools/list") {
          result = { tools: tools.map((name) => ({ name })) };
        } else if (parsed.method === "tools/call") {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tasks: [
                    {
                      id: "t-1",
                      status: "replied",
                      questionId: "q1",
                      createdAt: "2026-06-01T00:00:00.000Z",
                    },
                  ],
                }),
              },
            ],
            isError: false,
          };
        } else {
          result = { protocolVersion: "2025-06-18", capabilities: {} };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("监听失败");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("配对成功路径：匿名 401 + initialize + 工具清单一致 + 只读列表四步全过", async () => {
    const report = await runMcpSmoke(baseUrl, "good-token");
    expect(report.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(report.steps[2]?.detail).toContain("claim_ai_task");
    expect(report.steps[3]?.detail).toContain("t-1");
  });

  it("工具清单缺一 → tools/list 步骤 FAIL", async () => {
    tools = tools.slice(0, 3);
    const report = await runMcpSmoke(baseUrl, "good-token");
    expect(report.steps[2]?.ok).toBe(false);
    expect(report.steps[2]?.detail).toContain("缺少");
  });

  it("匿名请求未被拒绝（假端点放行）→ 防探测步骤 FAIL", async () => {
    anonymousPasses = true;
    const report = await runMcpSmoke(baseUrl, "good-token");
    expect(report.steps[0]?.ok).toBe(false);
    expect(report.steps[0]?.detail).toContain("401");
  });

  it("坏 token → initialize 步骤 FAIL", async () => {
    const report = await runMcpSmoke(baseUrl, "bad-token");
    expect(report.steps[1]?.ok).toBe(false);
  });
});

// ---------- link-check（假端点；票据快照核对） ----------

/** 造假分享正文（含全部区块标记 + 材料 anchor；variant 控制缺区块/夹带哨兵/页序缺口） */
function fakeShareHtml(
  variant: "full" | "no-answer" | "leak" | "uuid" | "gap",
): string {
  const answer = variant === "no-answer" ? "" : "<h2>参考答案</h2>";
  const leak = variant === "leak" ? "<p>教师私注：这个学生需要关注</p>" : "";
  const uuid =
    variant === "uuid" ? "<!-- 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9 -->" : "";
  // gap：材料行第 1 页缺失（缺失行不产 anchor），正文只有第 0/2 页锚点
  const anchors =
    variant === "gap"
      ? `<li><a href="/api/public/ai/share/tok/materials/0.png">题面圈画第 1 页（PNG 图片）</a></li>
<li><a href="/api/public/ai/share/tok/materials/2.png">草稿第 2 页（PNG 图片）</a></li>`
      : `<li><a href="/api/public/ai/share/tok/materials/0.png">题面圈画第 1 页（PNG 图片）</a></li>
<li><a href="/api/public/ai/share/tok/materials/1.png">草稿第 1 页（PNG 图片）</a></li>`;
  return `<!doctype html><html lang="zh-CN"><body>
<h1>AI 伴学分享（单题快照）</h1>
<p class="meta">题号：第 3 题</p>
<h2>题面</h2><pre class="md">合成题面</pre>
<h2>学生作答（求助时）</h2><pre class="md">A</pre>
${answer}<pre class="md">B</pre>
<h2>官方解析</h2><pre class="md">解析正文</pre>
<h2>学生的问题</h2><pre class="md">为什么选 B</pre>
<h2>材料（仅本题选定附件）</h2>
<ul class="materials">${anchors}</ul>
${leak}${uuid}</body></html>`;
}

describe("link-check（票据快照核对；node:http 假端点自证）", () => {
  let server: Server;
  let baseUrl: string;
  let variant: "full" | "no-answer" | "leak" | "uuid" | "gap";
  let status: number;
  let body: string;
  let brokenPages: Set<number>;

  beforeEach(async () => {
    variant = "full";
    status = 200;
    body = "";
    brokenPages = new Set();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      const pageMatch = /\/materials\/(\d+)\.png$/.exec(url);
      if (pageMatch !== null) {
        // 模拟服务端对缺失行页号的 500（AI_MATERIAL_BROKEN 同链路）
        if (brokenPages.has(Number(pageMatch[1]))) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "AI_MATERIAL_BROKEN" } }));
          return;
        }
        const png = makeNotePng(64, 32, 100);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(png.byteLength),
        });
        res.end(Buffer.from(png));
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body || "{}");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(fakeShareHtml(variant));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("监听失败");
    }
    baseUrl = `http://127.0.0.1:${address.port}/api/public/ai/share/tok`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("期望 ok：七处区块标记 + no-store + 材料 anchor 计数 + 附图拉取全过", async () => {
    const report = await runLinkCheck({
      url: baseUrl,
      expectation: "ok",
      mustContain: ["合成题面"],
      mustNotContain: ["别的学生的题"],
      method: "GET",
      fetchMaterials: true,
    });
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.materialCount).toBe(2);
  });

  it("材料页序缺口：按 anchor 真实页号拉取，不把缺失页当异常", async () => {
    variant = "gap";
    brokenPages.add(1); // 第 1 页是缺失行（500）——真实页号 0/2 应全部通过
    const report = await runLinkCheck({
      url: baseUrl,
      expectation: "ok",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: true,
    });
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.materialCount).toBe(2);
    const materials = report.steps.find((s) => s.name === "材料附件可拉取");
    expect(materials?.detail).toContain("第 1 张 200");
    expect(materials?.detail).toContain("第 3 张 200");
    expect(materials?.detail).not.toContain("第 2 张");
  });

  it("正文缺「参考答案」区块 → FAIL", async () => {
    variant = "no-answer";
    const report = await runLinkCheck({
      url: baseUrl,
      expectation: "ok",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed.map((s) => s.name)).toContain("正文含全部区块");
  });

  it("must-not-contain 命中私注哨兵 → FAIL", async () => {
    variant = "leak";
    const report = await runLinkCheck({
      url: baseUrl,
      expectation: "ok",
      mustContain: [],
      mustNotContain: ["教师私注"],
      method: "GET",
      fetchMaterials: false,
    });
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed.map((s) => s.name)).toContain("禁止哨兵不在正文");
  });

  it("正文夹带 UUID 形态标识 → FAIL（内部标识结构上不进正文）", async () => {
    variant = "uuid";
    const report = await runLinkCheck({
      url: baseUrl,
      expectation: "ok",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed.map((s) => s.name)).toContain("正文无 UUID 形态内部标识");
  });

  it("期望 expired 收到 200 → FAIL；收到 403+过期文案 → 通过", async () => {
    const bad = await runLinkCheck({
      url: baseUrl,
      expectation: "expired",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(bad.steps.every((s) => s.ok)).toBe(false);

    status = 403;
    body = JSON.stringify({
      error: {
        code: "AI_SHARE_EXPIRED",
        message: "分享链接已过期，附件不再可访问",
      },
    });
    const good = await runLinkCheck({
      url: baseUrl,
      expectation: "expired",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(good.steps.every((s) => s.ok)).toBe(true);
  });

  it("期望 revoked / missing 的状态码与文案核对", async () => {
    status = 403;
    body = JSON.stringify({
      error: {
        code: "AI_SHARE_REVOKED",
        message: "分享链接已撤销，附件不再可访问",
      },
    });
    const revoked = await runLinkCheck({
      url: baseUrl,
      expectation: "revoked",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(revoked.steps.every((s) => s.ok)).toBe(true);

    status = 404;
    body = JSON.stringify({
      error: { code: "NOT_FOUND", message: "分享链接不存在或已失效" },
    });
    const missing = await runLinkCheck({
      url: baseUrl,
      expectation: "missing",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(missing.steps.every((s) => s.ok)).toBe(true);
  });

  it("期望 stale：快照变更后的第三种 403（分享内容已更新）核对通过", async () => {
    status = 403;
    body = JSON.stringify({
      error: {
        code: "AI_SHARE_EXPIRED",
        message: "分享内容已更新，此链接已失效，请让学生重新生成链接",
      },
    });
    const good = await runLinkCheck({
      url: baseUrl,
      expectation: "stale",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(good.steps.every((s) => s.ok)).toBe(true);

    // 同一形态用 --expect expired 核对必须 FAIL（过期与快照变更文案不同，
    // 脚本不得把「分享内容已更新」误报成已过期通过）
    const wrong = await runLinkCheck({
      url: baseUrl,
      expectation: "expired",
      mustContain: [],
      mustNotContain: [],
      method: "GET",
      fetchMaterials: false,
    });
    expect(wrong.steps.every((s) => s.ok)).toBe(false);
  });
});

// ---------- CLI 入口（子进程；只读打开真实文件库自证） ----------

/** apps/server 根目录（脚本以 tsx 子进程运行时的 cwd） */
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const execFileAsync = promisify(execFile);

/** 以 tsx 子进程运行一个核对脚本，返回 stdout 与退出码（可注入额外环境变量） */
async function runScriptCli(
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> {
  // 子进程必须摘掉 VITEST 环境变量——脚本以它区分「直接运行」与「测试导入」
  const env = { ...process.env, ...extraEnv };
  delete env.VITEST;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        `scripts/b19-verify/${script}`,
        ...args,
      ],
      { cwd: SERVER_ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env },
    );
    return { stdout, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? -1 };
  }
}

describe("CLI 入口（tsx 子进程对合成文件库真实运行）", () => {
  it("materials-check：合成世界输出类别摘要且退出码 0；破坏后退出码 1", async () => {
    const world = makeFileWorld();
    const taskId = mkTask(world, 0, "q1");
    attachMaterials(world, taskId);
    world.db.$client.close();

    const good = await runScriptCli("materials-check.ts", [
      "--data-dir",
      dir,
      "--task",
      taskId,
    ]);
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("题面圈画 2 页");
    expect(good.stdout).toContain("materials-check：全部核对项通过");

    // 破坏一份材料文件后重跑：CLI 必须以退出码 1 报 FAIL（脚本检出力实证）
    // （world 连接已关；用脚本同款只读连接查路径，查完即关释放 Windows 句柄）
    const readonly = openReadonlyDb(dir);
    const paths = readonly
      .prepare(
        "SELECT png_path FROM ai_task_materials WHERE task_id = ? ORDER BY kind, page_index",
      )
      .all(taskId) as Array<{ png_path: string }>;
    readonly.close();
    rmSync(join(dir, paths[0]?.png_path ?? ""));
    const bad = await runScriptCli("materials-check.ts", [
      "--data-dir",
      dir,
      "--task",
      taskId,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("[FAIL] 题面圈画第 1 页材料文件缺失");
    // CLI 子进程耗时随全量并行负载波动（tsx 启动 + 模块图加载），显式超时
    // 防 vitest 默认 5s 在满载机器上误杀（与 b20-verify-scripts.test.ts 同款）
  }, 60_000);

  it("trace-audit：合成世界时间线含事实序列且退出码 0；篡改后退出码 1", async () => {
    const world = makeFileWorld();
    const taskId = mkTask(world, 0, "q1");
    await runStudentAiDispatchOnce(world.db, {
      dataDir: world.dataDir,
      rootSecret: ROOT_SECRET,
      transport: async () => ({ status: 200, headers: {}, bodyText: OK_BODY }),
      now: () => new Date(T0 + 1000),
    });
    world.db.$client.close();

    const good = await runScriptCli("trace-audit.ts", [
      "--data-dir",
      dir,
      "--task",
      taskId,
    ]);
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("task_created");
    expect(good.stdout).toContain("dispatched");
    expect(good.stdout).toContain("reply_received");
    expect(good.stdout).toContain("trace-audit：全部核对项通过");

    const raw = createDb(join(dir, "tutor.db"));
    raw.$client
      .prepare("UPDATE ai_tasks SET generation = 0 WHERE id = ?")
      .run(taskId);
    raw.$client.close();
    const bad = await runScriptCli("trace-audit.ts", [
      "--data-dir",
      dir,
      "--task",
      taskId,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain(
      "任务已开始出站（回信/失败/待确认/已领取）但 generation=0",
    );
  }, 60_000);

  it("materials-check：--task 指定的零材料任务显式输出无行，不静默吞掉", async () => {
    const world = makeFileWorld();
    const withMaterials = mkTask(world, 0, "q1");
    attachMaterials(world, withMaterials);
    const textOnly = mkTask(world, 100, "q2");
    world.db.$client.close();

    const run = await runScriptCli("materials-check.ts", [
      "--data-dir",
      dir,
      "--task",
      withMaterials,
      "--task",
      textOnly,
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`任务 ${textOnly}：无材料行`);
    expect(run.stdout).toContain("materials-check：全部核对项通过");
  }, 60_000);

  it("link-check：票据 URL 从 B19_LINK_URL 环境变量读取（token 不进命令行）", async () => {
    // 本地假端点扮演票据读端点（七区块正文 + no-store + 附件）
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.endsWith(".png")) {
        const png = makeNotePng(64, 32, 100);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(png.byteLength),
        });
        res.end(Buffer.from(png));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(fakeShareHtml("full"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("监听失败");
    }
    try {
      const run = await runScriptCli("link-check.ts", ["--expect", "ok"], {
        B19_LINK_URL: `http://127.0.0.1:${address.port}/api/public/ai/share/tok`,
      });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("link-check：全部核对项通过");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("seed-demo-world：生成合成世界（绝不触碰测试自身 DATA_DIR），产物可被两脚本核对，用完可整目录删除", async () => {
    const seeded = await runScriptCli("seed-demo-world.ts", []);
    expect(seeded.code).toBe(0);
    const dataDirLine = seeded.stdout
      .split("\n")
      .find((line) => line.trim().startsWith("DATA_DIR="));
    expect(dataDirLine).toBeDefined();
    const seededDir =
      dataDirLine?.trim().slice("DATA_DIR=".length).trim() ?? "";
    // 只认脚本自己打印的 %TEMP%/tutor-b19-demo- 前缀目录，删前再核对一遍
    expect(seededDir).toMatch(/[\\/]tutor-b19-demo-/);
    try {
      const materials = await runScriptCli("materials-check.ts", [
        "--data-dir",
        seededDir,
      ]);
      expect(materials.code).toBe(0);
      expect(materials.stdout).toContain("题面圈画 1 页");
      const trace = await runScriptCli("trace-audit.ts", [
        "--data-dir",
        seededDir,
      ]);
      expect(trace.code).toBe(0);
      expect(trace.stdout).toContain("trace-audit：全部核对项通过");
    } finally {
      // 关库后目录可整删（Windows 句柄释放的隐式验证）
      rmSync(seededDir, { recursive: true, force: true });
    }
  }, 240_000);
});

// ---------- 测试内工具 ----------

function failTexts(
  findings: readonly { level: string; message: string }[],
): string[] {
  return findings.filter((f) => f.level === "fail").map((f) => f.message);
}

interface RawMaterialRow {
  kind: string;
  page_index: number;
  png_path: string;
  pixel_width: number;
  pixel_height: number;
  byte_size: number;
  hash: string;
  state: string;
}

/** 原始 sqlite 查询材料行 → 脚本输入形态（与 CLI 的行映射同构） */
function queryMaterialRows(world: World, taskId: string): MaterialCheckRow[] {
  const raw = world.db.$client
    .prepare(
      `SELECT kind, page_index, png_path, pixel_width, pixel_height, byte_size, hash, state
       FROM ai_task_materials WHERE task_id = ? ORDER BY kind, page_index`,
    )
    .all(taskId) as RawMaterialRow[];
  return raw.map((row) => ({
    taskId,
    kind: row.kind,
    pageIndex: row.page_index,
    pngPath: row.png_path,
    pixelWidth: row.pixel_width,
    pixelHeight: row.pixel_height,
    byteSize: row.byte_size,
    hash: row.hash,
    state: row.state,
  }));
}

interface RawTraceShape {
  tasks: Array<Record<string, string | number | null>>;
  messages: Array<Record<string, string>>;
  facts: Array<Record<string, string | number | null>>;
  tickets: Array<Record<string, string | number | null>>;
}

/** 原始 sqlite 查询任务/消息/事实/票据 → auditTrace 输入（snake→camel） */
function readTraceInput(world: World): TraceAuditInput {
  const raw: RawTraceShape = {
    tasks: world.db.$client
      .prepare(
        `SELECT id, student_id, attempt_id, question_id, channel, mode_at_send, status, generation,
                error_text, retry_count, reply_delivered_at, cancel_requested_at, archived_at, created_at, updated_at
         FROM ai_tasks ORDER BY created_at`,
      )
      .all() as Array<Record<string, string | number | null>>,
    messages: world.db.$client
      .prepare(
        "SELECT task_id, role, content_md, created_at FROM ai_messages ORDER BY created_at",
      )
      .all() as Array<Record<string, string>>,
    facts: world.db.$client
      .prepare(
        "SELECT task_id, type, detail_json, server_ts FROM ai_facts ORDER BY server_ts",
      )
      .all() as Array<Record<string, string | number | null>>,
    tickets: world.db.$client
      .prepare(
        "SELECT task_id, view_count, last_viewed_at, revoked_at, expires_at FROM ai_share_tickets",
      )
      .all() as Array<Record<string, string | number | null>>,
  };
  return {
    tasks: raw.tasks.map((row) => ({
      id: String(row.id),
      studentId: String(row.student_id),
      attemptId: String(row.attempt_id),
      questionId: String(row.question_id),
      channel: String(row.channel),
      modeAtSend: String(row.mode_at_send),
      status: String(row.status),
      generation: Number(row.generation),
      errorText: row.error_text === null ? null : String(row.error_text),
      retryCount: Number(row.retry_count),
      replyDeliveredAt:
        row.reply_delivered_at === null ? null : String(row.reply_delivered_at),
      cancelRequestedAt:
        row.cancel_requested_at === null
          ? null
          : String(row.cancel_requested_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    messages: raw.messages.map((row) => ({
      taskId: String(row.task_id),
      role: String(row.role),
      contentMd: String(row.content_md),
      createdAt: String(row.created_at),
    })),
    facts: raw.facts.map((row) => ({
      taskId: String(row.task_id),
      type: String(row.type),
      detailJson: row.detail_json === null ? null : String(row.detail_json),
      serverTs: String(row.server_ts),
    })),
    tickets: raw.tickets.map((row) => ({
      taskId: String(row.task_id),
      viewCount: Number(row.view_count),
      lastViewedAt:
        row.last_viewed_at === null ? null : String(row.last_viewed_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      expiresAt: String(row.expires_at),
    })),
  };
}
