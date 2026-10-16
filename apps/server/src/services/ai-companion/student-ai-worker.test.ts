import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackfills } from "../../db/backfill.ts";
import { createDbHandle, type Db } from "../../db/client.ts";
import { runMigrations } from "../../db/migrate.ts";
import {
  aiFacts,
  aiMessages,
  aiPolicyOverrides,
  aiTasks,
  attempts,
  responses,
  teachers,
} from "../../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../../db/test-utils.ts";
import {
  insertAttempt,
  insertResponse,
} from "../../test/ai-companion-fixtures.ts";
import { makeNotePng, makeStudent } from "../../test/note-fixtures.ts";
import { createStudentAiConnection } from "./connection-service.ts";
import {
  type GuardedResponse,
  OutboundTargetError,
  requestWithTargetGuard,
} from "./outbound-target.ts";
import type { ProviderTransport } from "./provider-client.ts";
import { attachAiTaskMaterials } from "./student-ai-materials.ts";
import {
  cancelAiTask,
  createAiTask,
  followupStudentAiTask,
  recoverAiQueue,
  resumeAiTask,
  retryAiTask,
} from "./student-ai-queue.ts";
import {
  AI_DISPATCH_MAX_ATTEMPTS,
  AI_DISPATCH_PER_STUDENT_CONCURRENCY,
  runStudentAiDispatchOnce,
  startStudentAiWorker,
} from "./student-ai-worker.ts";

/**
 * SAI-17 页内 AI 异步执行 worker 测试（B09 必测五条 + 完成条件三条）。
 *
 * 主链路用本机真实 HTTP fake provider（node:http 服务器 + 连接层桩：lookup
 * 解析为公网 IP 过守卫、createConnection 落本机端口）——出站走真实 socket、
 * 真实装配（SAI-09 冻结快照）与真实队列链（SAI-12 begin/complete CAS），
 * 绝不直接改 DB status。分类与生命周期边缘用进程内 transport 桩。
 *
 * 必测对照：
 * ① 正常文字与多图 / 结构损坏 / 超大响应 / 不支持图未减选阻断；
 * ② 429→按时重试→成功 / 401 直接需重配 / Retry-After 不失控；
 * ③ 两 worker 不重复交付 / 迟到代次写回拒绝 / 未知收费状态不自动重发；
 * ④ 页面关闭仍执行（服务端无会话参与）/ 重启恢复 / 恢复库旧回执不越权 / 取消不出站；
 * ⑤ 派发在途时无同步事务阻塞（作答保存可及时处理）。
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const SECRET = "worker-test-secret-0001";
const ROOT_SECRET = "11".repeat(32);
const BASE_URL = "http://api.fake-provider.test/v1";

const okBodyText = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "FAKE-REPLY" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

// ---------- 世界与夹具 ----------

interface World {
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
}

function setupWorld(db: Db): World {
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  const questionId = "q1";
  insertResponse(db, attemptId, questionId);
  return { studentId, attemptId, questionId };
}

function mkInappTask(
  db: Db,
  world: World,
  opts?: { at?: number; questionId?: string },
): string {
  return createAiTask(
    db,
    {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: opts?.questionId ?? world.questionId,
      question: "请帮我讲解本题",
      channel: "inapp",
      mutationId: `mut-${Math.random().toString(36).slice(2)}`,
    },
    { hmacSecret: SECRET, now: new Date(T0 + (opts?.at ?? 0)) },
  ).task.id;
}

function addInappConnection(
  db: Db,
  studentId: string,
  opts?: { imageCapability?: "unknown" | "supported" | "unsupported" },
): void {
  createStudentAiConnection(db, {
    studentId,
    rootSecret: ROOT_SECRET,
    request: {
      channel: "inapp",
      baseUrl: BASE_URL,
      model: "glm-test",
      apiKey: "sk-test-key-123",
      isDefault: true,
      ...(opts?.imageCapability !== undefined && {
        imageCapability: opts.imageCapability,
      }),
    },
  });
}

function taskStatus(db: Db, taskId: string): string {
  const row = db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
  if (row === undefined) throw new Error("任务行不存在");
  return row.status;
}

function taskErrorText(db: Db, taskId: string): string | null {
  return (
    db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get()?.errorText ??
    null
  );
}

function assistantReplies(db: Db, taskId: string): string[] {
  return db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "assistant")))
    .all()
    .map((m) => m.contentMd);
}

function factTypes(db: Db, taskId: string): string[] {
  return db
    .select()
    .from(aiFacts)
    .where(eq(aiFacts.taskId, taskId))
    .all()
    .map((f) => f.type);
}

/**
 * paused 原因（SAI-12 既有语义：policy 类失败不写行 errorText，原因落在
 * paused 事实的 detailJson——断言按此口径取）
 */
function pausedReasonOf(db: Db, taskId: string): string | null {
  const rows = db
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "paused")))
    .all();
  if (rows.length === 0) return null;
  const detail = JSON.parse(rows.at(-1)?.detailJson ?? "{}") as {
    errorText?: string;
  };
  return detail.errorText ?? null;
}

/** 轮询等待条件成立（真实 HTTP 时序用，超时 fail） */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("测试条件等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------- 本机真实 HTTP fake provider ----------

interface RecordedRequest {
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly at: number;
}

type FakeBehavior = (
  respond: (
    status: number,
    headers: Record<string, string>,
    bodyText: string,
  ) => void,
) => void | Promise<void>;

interface FakeProvider {
  readonly requests: RecordedRequest[];
  readonly transport: ProviderTransport;
  close(): Promise<void>;
}

async function startFakeProvider(
  behavior: FakeBehavior,
): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<{ destroy: () => void }>();
  let closed = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
        at: Date.now(),
      });
      void Promise.resolve(
        behavior((status, headers, bodyText) => {
          res.writeHead(status, headers);
          res.end(bodyText);
        }),
      ).catch(() => {
        res.destroy();
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake provider 端口获取失败");
  }
  const port = address.port;
  // 连接层桩（outbound-target.test 同款）：lookup 给公网 IP 过 IP 守卫，
  // createConnection 把真实 socket 落到本机 fake provider——HTTP/装配/守卫全真
  const transport: ProviderTransport = (request) =>
    requestWithTargetGuard(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs: request.timeoutMs,
      lookup: (
        _h: string,
        _o: unknown,
        cb: (err: Error | null, address?: string, family?: number) => void,
      ) => cb(null, "93.184.216.34", 4),
      createConnection: () => connect(port, "127.0.0.1"),
    });
  return {
    requests,
    transport,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const respondJson: FakeBehavior = (respond) => {
  respond(200, { "content-type": "application/json" }, okBodyText);
};

/**
 * 挂起出站的 transport + 手动释放门。release 的目标经闭包赋值后从对象
 * 方法内读取——TS 对「闭包内赋值的 let」在直线流里做窄化会把它收成
 * never（option-call 报 TS2349），方法内读取保持声明类型。
 */
function heldTransportOf(): {
  readonly transport: ProviderTransport;
  /** 释放挂起的出站（返回 200 标准回复）；无挂起时 no-op */
  readonly release: () => void;
} {
  let pending: ((guarded: GuardedResponse) => void) | null = null;
  const transport: ProviderTransport = async () =>
    new Promise<GuardedResponse>((resolve) => {
      pending = resolve;
    });
  return {
    transport,
    release: () => {
      pending?.({ status: 200, headers: {}, bodyText: okBodyText });
    },
  };
}

// ---------- 必测①主链路：真实 HTTP fake provider ----------

describe("SAI-17 worker 主链路（真实 HTTP / 装配 / 队列）", () => {
  it("正常文字：出站携带系统段+题面+答案解析+诉求（授权外发），回信入库 replied；判分与提交状态不受模型结果影响", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const provider = await startFakeProvider(respondJson);
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.replied).toBe(1);
      expect(taskStatus(db, taskId)).toBe("replied");
      expect(assistantReplies(db, taskId)).toEqual(["FAKE-REPLY"]);
      expect(factTypes(db, taskId)).toContain("dispatched");
      expect(factTypes(db, taskId)).toContain("reply_received");
      // 出站载荷单请求；授权内容确实外发（答案/解析/学生问题），对账标识只进 UA
      expect(provider.requests.length).toBe(1);
      const body = provider.requests[0]?.body ?? "";
      expect(body).toContain("题干");
      expect(body).toContain("解析");
      expect(body).toContain("请帮我讲解本题");
      expect(provider.requests[0]?.headers["user-agent"]).toContain(taskId);
      expect(body).not.toContain(taskId);
      // 完成条件②：模型结果不能改变 answerJson / 判分 / 提交状态
      const response = db
        .select()
        .from(responses)
        .where(eq(responses.attemptId, world.attemptId))
        .get();
      expect(response?.answerJson).toBeNull();
      expect(response?.submittedAt).toBeNull();
      const attempt = db
        .select()
        .from(attempts)
        .where(eq(attempts.id, world.attemptId))
        .get();
      expect(attempt?.status).toBe("draft");
    } finally {
      await provider.close();
    }
  });

  it("多图：材料 PNG 以 image_url data 部件附在上下文消息，材料清单提示进正文", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const pngA = makeNotePng(320, 200);
    const pngB = makeNotePng(320, 200, 16);
    attachAiTaskMaterials(db, dataDir, {
      studentId: world.studentId,
      taskId,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: pngA,
        },
        {
          kind: "draft",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: pngB,
        },
      ],
    });
    const provider = await startFakeProvider(respondJson);
    try {
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(taskStatus(db, taskId)).toBe("replied");
      const parsed = JSON.parse(provider.requests[0]?.body ?? "{}") as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const context = parsed.messages?.[1]?.content as Array<
        Record<string, unknown>
      >;
      const textPart = context[0] as { type: string; text?: string };
      expect(textPart.type).toBe("text");
      expect(textPart.text).toContain("随本消息附带 2 张书写材料图片");
      expect(context.filter((p) => p.type === "image_url")).toEqual([
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(pngA).toString("base64")}`,
          },
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(pngB).toString("base64")}`,
          },
        },
      ]);
    } finally {
      await provider.close();
    }
  });

  it("结构损坏：200 但不可解析 → failed（不自动重试），单次出站", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const provider = await startFakeProvider((respond) => {
      respond(
        200,
        { "content-type": "application/json" },
        "<html>broken</html>",
      );
    });
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.failed).toBe(1);
      expect(taskStatus(db, taskId)).toBe("failed");
      expect(taskErrorText(db, taskId)).toBe("供应商响应格式无法解析");
      expect(assistantReplies(db, taskId)).toEqual([]);
      expect(provider.requests.length).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("超大响应：响应体超 2MiB 被中止 → uncertain（状态待确认），单次出站不自动重发", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const provider = await startFakeProvider((respond) => {
      respond(
        200,
        { "content-type": "application/json" },
        "x".repeat(3 * 1024 * 1024),
      );
    });
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.uncertain).toBe(1);
      expect(taskStatus(db, taskId)).toBe("uncertain");
      expect(assistantReplies(db, taskId)).toEqual([]);
      expect(provider.requests.length).toBe(1);
      expect(taskErrorText(db, taskId)).toContain("待确认");
    } finally {
      await provider.close();
    }
  });

  it("模型不支持图且学生未减选：出站前阻断（零请求）→ paused 明示，不偷偷丢图", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId, { imageCapability: "unsupported" });
    const taskId = mkInappTask(db, world);
    attachAiTaskMaterials(db, dataDir, {
      studentId: world.studentId,
      taskId,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png: makeNotePng(320, 200),
        },
      ],
    });
    const provider = await startFakeProvider(respondJson);
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.paused).toBe(1);
      expect(taskStatus(db, taskId)).toBe("paused");
      expect(provider.requests.length).toBe(0);
      expect(pausedReasonOf(db, taskId)).toContain("不支持识图");
    } finally {
      await provider.close();
    }
  });

  it("任务上下文损坏：装配层拒绝重建，零出站不伪造题面，按可重试失败明示", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    // 冻结快照损坏（防御路径）：快照解析失败时不得据残骸伪造题面出站
    db.update(aiTasks)
      .set({ contextSnapshotJson: "{broken" })
      .where(eq(aiTasks.id, taskId))
      .run();
    const provider = await startFakeProvider(respondJson);
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.failed).toBe(1);
      expect(taskStatus(db, taskId)).toBe("failed");
      expect(taskErrorText(db, taskId)).toContain("本次未出站");
      expect(assistantReplies(db, taskId)).toEqual([]);
      expect(provider.requests.length).toBe(0);
    } finally {
      await provider.close();
    }
  });

  it("未配置页内连接 / Key 需重配：直接 paused 需重配，零出站不重试", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    const taskId = mkInappTask(db, world);
    // 学生没有任何 inapp 连接
    const summary = await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: async () => {
        throw new Error("不应出站");
      },
      now: () => new Date(T0 + 1000),
    });
    expect(summary.paused).toBe(1);
    expect(taskStatus(db, taskId)).toBe("paused");
    expect(pausedReasonOf(db, taskId)).toContain("连接");
    // needs_rekey：有连接但根密钥不符（换了 secret.key）
    const world2 = setupWorld(db);
    addInappConnection(db, world2.studentId);
    const task2 = mkInappTask(db, world2);
    const summary2 = await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: "22".repeat(32),
      transport: async () => {
        throw new Error("不应出站");
      },
      now: () => new Date(T0 + 2000),
    });
    expect(summary2.paused).toBe(1);
    expect(taskStatus(db, task2)).toBe("paused");
    expect(pausedReasonOf(db, task2)).toContain("重新配置");
  });
});

// ---------- 必测②退避与重试 ----------

describe("SAI-17 worker 退避与重试", () => {
  it("429→按 Retry-After 指引等待→重试成功（replied，两次出站）", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    let hits = 0;
    const provider = await startFakeProvider((respond) => {
      hits += 1;
      if (hits === 1) {
        respond(429, { "retry-after": "1" }, "{}");
        return;
      }
      respondJson(respond);
    });
    try {
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(taskStatus(db, taskId)).toBe("replied");
      expect(assistantReplies(db, taskId)).toEqual(["FAKE-REPLY"]);
      expect(provider.requests.length).toBe(2);
      // 第二次出站发生在 Retry-After 指引的等待之后（≥0.9s）
      const gap =
        (provider.requests[1]?.at ?? 0) - (provider.requests[0]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(900);
    } finally {
      await provider.close();
    }
  });

  it("401：直接需重配（paused，单次出站），后续运行不再出站", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const provider = await startFakeProvider((respond) => {
      respond(401, {}, "{}");
    });
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.paused).toBe(1);
      expect(taskStatus(db, taskId)).toBe("paused");
      expect(pausedReasonOf(db, taskId)).toBe("API Key 无效或无权限访问该模型");
      expect(provider.requests.length).toBe(1);
      // paused 不进扫描：再次运行零出站
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 2000),
      });
      expect(provider.requests.length).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("Retry-After 3600s 不导致失控长阻塞：等待按上限裁剪，尝试次数有界后 failed", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const provider = await startFakeProvider((respond) => {
      respond(429, { "retry-after": "3600" }, "{}");
    });
    try {
      const startedAt = Date.now();
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
        retryWaitMaxMs: 200,
      });
      const elapsed = Date.now() - startedAt;
      expect(summary.failed).toBe(1);
      expect(taskStatus(db, taskId)).toBe("failed");
      // 有界尝试（1 + 2 重试）且总时长远小于指引的 3600s（按 200ms 上限 × 2 计）
      expect(provider.requests.length).toBe(AI_DISPATCH_MAX_ATTEMPTS);
      expect(elapsed).toBeLessThan(5000);
      expect(taskErrorText(db, taskId)).toContain("受限");
    } finally {
      await provider.close();
    }
  });
});

// ---------- 必测③并发与写回 CAS ----------

describe("SAI-17 worker 并发与写回 CAS", () => {
  it("两 worker 不重复交付：先 begin 者独占出站与写回，后者零出站", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const held = heldTransportOf();
    let firstCalls = 0;
    const heldTransport: ProviderTransport = async (request) => {
      firstCalls += 1;
      return held.transport(request);
    };
    const provider = await startFakeProvider(respondJson);
    try {
      const firstRun = runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: heldTransport,
        now: () => new Date(T0 + 1000),
      });
      await until(() => taskStatus(db, taskId) === "dispatching");
      // 第二个 worker：任务已 dispatching，不得再次出站
      const secondSummary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1100),
      });
      expect(secondSummary.dispatched).toBe(0);
      expect(provider.requests.length).toBe(0);
      held.release();
      const firstSummary = await firstRun;
      expect(firstSummary.replied).toBe(1);
      expect(firstCalls).toBe(1);
      expect(taskStatus(db, taskId)).toBe("replied");
      expect(assistantReplies(db, taskId)).toEqual(["FAKE-REPLY"]);
    } finally {
      await provider.close();
    }
  });

  it("迟到代次写回拒绝：恢复→重试→新代回复后，旧代迟到回信只记事实不覆盖", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const held = heldTransportOf();
    const heldTransport: ProviderTransport = held.transport;
    const firstRun = runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: heldTransport,
      now: () => new Date(T0),
    });
    await until(() => taskStatus(db, taskId) === "dispatching");
    // 出站超时窗口过去：恢复 → uncertain → 学生显式重试 → 第二次派发成功
    recoverAiQueue(db, { now: new Date(T0 + 120_000) });
    expect(taskStatus(db, taskId)).toBe("uncertain");
    retryAiTask(
      db,
      { studentId: world.studentId, taskId },
      { now: new Date(T0 + 200_000) },
    );
    const provider = await startFakeProvider((respond) => {
      respond(
        200,
        { "content-type": "application/json" },
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "SECOND-REPLY" } },
          ],
        }),
      );
    });
    try {
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 201_000),
      });
      expect(taskStatus(db, taskId)).toBe("replied");
      expect(assistantReplies(db, taskId)).toEqual(["SECOND-REPLY"]);
      // 旧代（generation=1）迟到回信到达：只记 late_reply 事实，不覆盖
      held.release();
      await firstRun;
      expect(assistantReplies(db, taskId)).toEqual(["SECOND-REPLY"]);
      const lateFacts = db
        .select()
        .from(aiFacts)
        .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "late_reply")))
        .all();
      expect(lateFacts.length).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("未知收费状态（超时）：单次出站即 uncertain，绝不自动无限重发", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    let calls = 0;
    const timeoutTransport: ProviderTransport = async () => {
      calls += 1;
      throw new OutboundTargetError("TIMEOUT", "出站请求超时");
    };
    const summary = await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: timeoutTransport,
      now: () => new Date(T0 + 1000),
    });
    expect(summary.uncertain).toBe(1);
    expect(taskStatus(db, taskId)).toBe("uncertain");
    expect(calls).toBe(1);
    expect(taskErrorText(db, taskId)).toContain("待确认");
    // 再次运行：uncertain 不进扫描，无自动重发
    await runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: timeoutTransport,
      now: () => new Date(T0 + 5000),
    });
    expect(calls).toBe(1);
    expect(taskStatus(db, taskId)).toBe("uncertain");
  });

  it("同学生并发上限：五任务一次运行至多 3 笔在途，其余下一轮补发", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      insertResponse(db, world.attemptId, `q-cap-${i}`);
      ids.push(mkInappTask(db, world, { questionId: `q-cap-${i}`, at: i }));
    }
    const provider = await startFakeProvider((respond) => {
      // 挂起全部响应直至放行（观察在途上限）
      void respond;
    });
    try {
      const run = runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 10_000),
      });
      await until(() => provider.requests.length >= 3, 3000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(provider.requests.length).toBe(
        AI_DISPATCH_PER_STUDENT_CONCURRENCY,
      );
      // 关停 fake provider 挂起响应 → 三笔按网络失败落 failed，其余仍 created
      await provider.close();
      await run;
      const statuses = ids.map((id) => taskStatus(db, id));
      expect(statuses.filter((s) => s === "failed").length).toBe(3);
      expect(statuses.filter((s) => s === "created").length).toBe(2);
    } finally {
      await provider.close();
    }
  });
});

// ---------- 必测④生命周期与恢复 ----------

describe("SAI-17 worker 生命周期与恢复", () => {
  it("取消 created 任务：不出站、不派发；MCP 任务不被 API worker 抢走", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    cancelAiTask(
      db,
      { studentId: world.studentId, taskId },
      { now: new Date(T0 + 500) },
    );
    const mcpTask = createAiTask(
      db,
      {
        studentId: world.studentId,
        attemptId: world.attemptId,
        questionId: world.questionId,
        question: "MCP 队列任务",
        channel: "mcp",
        mutationId: "mut-mcp-1",
      },
      { hmacSecret: SECRET, now: new Date(T0) },
    ).task.id;
    const provider = await startFakeProvider(respondJson);
    try {
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(summary.dispatched).toBe(0);
      expect(provider.requests.length).toBe(0);
      expect(taskStatus(db, taskId)).toBe("cancelled");
      expect(taskStatus(db, mcpTask)).toBe("created");
    } finally {
      await provider.close();
    }
  });

  it("教师改为 post_submit_only：派发前拦截转 paused 零出站；恢复开放+resume 后正常派发", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: world.studentId,
        mode: "post_submit_only",
        updatedAt: new Date(T0 + 600).toISOString(),
      })
      .run();
    const provider = await startFakeProvider(respondJson);
    try {
      const blocked = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(blocked.paused).toBe(1);
      expect(taskStatus(db, taskId)).toBe("paused");
      expect(provider.requests.length).toBe(0);
      // 教师恢复开放 + 学生 resume：重新派发成功
      db.delete(aiPolicyOverrides)
        .where(eq(aiPolicyOverrides.subjectId, world.studentId))
        .run();
      resumeAiTask(
        db,
        { studentId: world.studentId, taskId },
        { now: new Date(T0 + 2000) },
      );
      const resumed = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 3000),
      });
      expect(resumed.replied).toBe(1);
      expect(provider.requests.length).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("重启恢复：stale dispatching → uncertain；created 照常派发；replied 不重复执行", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    // 一笔已完成（replied 不重复执行）与一笔新任务
    insertResponse(db, world.attemptId, "q-done");
    const doneId = mkInappTask(db, world, { at: 0, questionId: "q-done" });
    const provider = await startFakeProvider(respondJson);
    try {
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(taskStatus(db, doneId)).toBe("replied");
      const afterFirst = provider.requests.length;
      // 人为制造一行 stale dispatching（重启前崩溃窗口）
      insertResponse(db, world.attemptId, "q-stale");
      const staleId = mkInappTask(db, world, {
        at: 2000,
        questionId: "q-stale",
      });
      db.update(aiTasks)
        .set({
          status: "dispatching",
          generation: 1,
          updatedAt: new Date(T0).toISOString(),
        })
        .where(eq(aiTasks.id, staleId))
        .run();
      insertResponse(db, world.attemptId, "q-fresh");
      const freshId = mkInappTask(db, world, {
        at: 3000,
        questionId: "q-fresh",
      });
      const summary = await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 120_000),
      });
      expect(taskStatus(db, staleId)).toBe("uncertain");
      expect(taskStatus(db, freshId)).toBe("replied");
      expect(taskStatus(db, doneId)).toBe("replied");
      // replied 未重复出站：本轮只新增 fresh 一笔
      expect(provider.requests.length).toBe(afterFirst + 1);
      expect(summary.replied).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("恢复库旧回执（runtimeEpoch 失效）：回信只记迟到事实，学生不可见", async () => {
    const dir = createTestDir();
    const path = join(dir, "tutor.db");
    const openHook = (fresh: Db): void => {
      runMigrations(fresh);
      runBackfills(fresh);
      fresh
        .insert(teachers)
        .values({
          id: TEST_TEACHER_ID,
          loginName: "teacher",
          isAdmin: true,
          disabledAt: null,
          passwordHash: null,
          apiToken: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        .onConflictDoNothing()
        .run();
    };
    const handle = createDbHandle(path, openHook);
    const db = handle.db;
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const held = heldTransportOf();
    const run = runStudentAiDispatchOnce(db, {
      dataDir: dir,
      rootSecret: ROOT_SECRET,
      transport: held.transport,
      now: () => new Date(T0),
    });
    await until(() => taskStatus(db, taskId) === "dispatching");
    // 备份恢复语义：底层连接被换（runtimeEpoch 变化）
    handle.restart();
    held.release();
    await run;
    // 旧代回执只记事实：任务未 replied、回信不入 ai_messages
    expect(assistantReplies(db, taskId)).toEqual([]);
    const lateFacts = db
      .select()
      .from(aiFacts)
      .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "late_reply")))
      .all();
    expect(lateFacts.length).toBe(1);
    const detail = JSON.parse(lateFacts[0]?.detailJson ?? "{}") as {
      reason?: string;
    };
    expect(detail.reason).toBe("runtime_epoch_stale");
    expect(taskStatus(db, taskId)).toBe("dispatching");
  });
});

// ---------- 必测⑤主线程不阻塞 + 生命周期定时器 ----------

describe("SAI-17 worker 调度与阻塞", () => {
  it("派发在途时不持有事务：作答保存类同步写可即时完成", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const held = heldTransportOf();
    const run = runStudentAiDispatchOnce(db, {
      dataDir,
      rootSecret: ROOT_SECRET,
      transport: held.transport,
      now: () => new Date(T0),
    });
    await until(() => taskStatus(db, taskId) === "dispatching");
    // 出站等待期间：无未决事务（better-sqlite3 同步模型下事务跨 await 会
    // 把后续写并进同事务），作答保存形态的同步写立即成功
    expect(db.$client.inTransaction).toBe(false);
    insertResponse(db, world.attemptId, "q-while-inflight");
    db.update(responses)
      .set({ answerJson: JSON.stringify({ kind: "choice", index: 0 }) })
      .where(eq(responses.attemptId, world.attemptId))
      .run();
    held.release();
    await run;
    expect(taskStatus(db, taskId)).toBe("replied");
    const saved = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, world.attemptId))
      .all();
    // 作答保存与 AI 回信互不影响
    expect(saved.some((r) => r.questionId === "q-while-inflight")).toBe(true);
    expect(saved.find((r) => r.questionId === "q1")?.answerJson).toContain(
      "choice",
    );
  });

  it("启停单入口：间隔派发、stop 后零新增、无悬挂定时器、重复 start 幂等", async () => {
    vi.useFakeTimers();
    try {
      const db = createTestDb();
      const dataDir = createTestDir();
      const world = setupWorld(db);
      addInappConnection(db, world.studentId);
      const taskId = mkInappTask(db, world);
      let calls = 0;
      const transport: ProviderTransport = async () => {
        calls += 1;
        return { status: 200, headers: {}, bodyText: okBodyText };
      };
      const handle = startStudentAiWorker({
        db,
        dataDir,
        rootSecret: ROOT_SECRET,
        transport,
        now: () => new Date(T0 + 1000),
        intervalMs: 1000,
      });
      // 重复 start：同一句柄（幂等），不会双份定时器
      const again = startStudentAiWorker({
        db,
        dataDir,
        rootSecret: ROOT_SECRET,
        transport,
        now: () => new Date(T0 + 1000),
        intervalMs: 1000,
      });
      expect(again).toBe(handle);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      expect(taskStatus(db, taskId)).toBe("replied");
      handle.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
      // 停止后重新 start：新实例可继续派发
      insertResponse(db, world.attemptId, "q-restart");
      const newTaskId = mkInappTask(db, world, { questionId: "q-restart" });
      const second = startStudentAiWorker({
        db,
        dataDir,
        rootSecret: ROOT_SECRET,
        transport,
        now: () => new Date(T0 + 2000),
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(taskStatus(db, newTaskId)).toBe("replied");
      second.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- SAI-21 追问出站（末条学生消息为诉求；历史完整；快照不重采） ----------

describe("SAI-21 worker 追问出站", () => {
  it("追问后再次派发：诉求取末条学生消息，首问与回信整体入历史，冻结快照照常外发", async () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const world = setupWorld(db);
    addInappConnection(db, world.studentId);
    const taskId = mkInappTask(db, world);
    const snapshotBefore = db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, taskId))
      .get()?.contextSnapshotJson;
    const provider = await startFakeProvider(respondJson);
    try {
      // 首轮：出站并写回（真实 HTTP fake provider 链）
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 1000),
      });
      expect(taskStatus(db, taskId)).toBe("replied");

      // 追问（同题对话续轮；快照不动）
      const followup = followupStudentAiTask(
        db,
        { studentId: world.studentId, taskId, question: "第二步为什么要移项？" },
        { now: new Date(T0 + 2000) },
      );
      expect(followup.appended).toBe(true);
      expect(followup.messages.map((message) => message.role)).toEqual([
        "student",
        "assistant",
        "student",
      ]);
      const snapshotAfterFollowup = db
        .select()
        .from(aiTasks)
        .where(eq(aiTasks.id, taskId))
        .get()?.contextSnapshotJson;
      expect(snapshotAfterFollowup).toBe(snapshotBefore);

      // 再派发：出站诉求 = 追问（末条学生消息），历史含首问与回信
      const requestsBefore = provider.requests.length;
      await runStudentAiDispatchOnce(db, {
        dataDir,
        rootSecret: ROOT_SECRET,
        transport: provider.transport,
        now: () => new Date(T0 + 3000),
      });
      expect(provider.requests.length).toBe(requestsBefore + 1);
      expect(taskStatus(db, taskId)).toBe("replied");
      expect(assistantReplies(db, taskId)).toEqual([
        "FAKE-REPLY",
        "FAKE-REPLY",
      ]);
      const body = provider.requests[requestsBefore]?.body ?? "";
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const messages = parsed.messages ?? [];
      // 诉求在末位且是追问本身；首问/回信作为历史在中段（system→数据段→历史→诉求）
      const appeal = messages[messages.length - 1];
      expect(appeal?.role).toBe("user");
      expect(String(appeal?.content)).toContain("第二步为什么要移项？");
      const historyText = JSON.stringify(
        messages.slice(0, messages.length - 1),
      );
      expect(historyText).toContain("请帮我讲解本题");
      expect(historyText).toContain("FAKE-REPLY");
      // 冻结快照（题面/解析）照常随数据段外发——追问不换快照不重采材料
      expect(body).toContain("题干");
      expect(body).toContain("解析");
    } finally {
      await provider.close();
    }
  });
});
