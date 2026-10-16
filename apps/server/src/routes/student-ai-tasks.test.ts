import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApiErr } from "@tutor/contract";
import {
  aiQueueSummaryOkSchema,
  aiTaskDetailOkSchema,
  aiTaskListOkSchema,
  aiTaskOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import {
  aiConnections,
  aiFacts,
  aiPolicyOverrides,
  aiTasks,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { attachAiTaskMaterials } from "../services/ai-companion/student-ai-materials.ts";
import {
  beginInappDispatch,
  claimMcpTask,
  completeInappDispatch,
  failInappDispatch,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeNotePng } from "../test/note-fixtures.ts";

/**
 * SAI-13 学生任务路由测试（B07；B00 §4.2 API 表 + 需求规格 §2/§3.3/§8）。
 *
 * 最小接口测试表逐行：
 * ① 四态：每个受保护路由的无会话 / 教师 Cookie / 参数错误 / 正常 schema；
 * ② create：默认已有参考在上下文（快照双断言——响应零答案 + 库内快照含
 *    答案解析）；未完成禁用 → 拒绝且无任务/文件副作用；
 * ③ list/detail：跨账号拒绝（404 同文案防枚举）；禁用不泄待交付回信；
 * ④ update/retry：已领取不能更新；同 requestId 不重复；
 * ⑤ cancel/opened：事实与处理状态分开；不能替别人取消/标已读；
 * ⑥ 错误/附件：不带其他题、私注、真实路径或 secret。
 *
 * 全部学生可读响应过 assertNoLeak（AGENTS.md 硬规则 3；受控 AI 出口唯一
 * 例外是外发快照本身——由 ② 的库内双断言覆盖，不出现在 HTTP 响应）。
 */

const SECRET_SENTINEL = "queue-test-secret-0001";

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  for (const id of ["s-a", "s-b"])
    db.insert(students)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        displayName: id,
        loginName: id,
        linkToken: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  const attemptId = insertAttempt(db, { studentId: "s-a" });
  const questionId = "q-alpha";
  insertResponse(db, attemptId, questionId);
  // s-a/s-b 各持一条 active 连接：create 知情门只看存在性（服务端强制
  // 用例按需删除 s-a 连接构造无连接态）
  for (const studentId of ["s-a", "s-b"])
    insertAiConnectionFixture(db, studentId);
  // 同卷邻题：携带跨题哨兵（题干/解析）与教师私注哨兵，供泄露扫描
  db.insert(responses)
    .values({
      id: randomUUID(),
      attemptId,
      questionId: "q-beta",
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["其他题考点哨兵BETA"],
        stemMd: "其他题干哨兵BETA",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 0 },
        hints: [],
        solutionMd: "其他题解析哨兵BETA",
        sourceMd: "",
        id: "q-beta",
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: "教师私注哨兵TC",
    })
    .run();
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = (id: string) =>
    `tutor_student_session=${createStudentSession(db, id).token}`;
  return {
    app,
    db,
    dataDir,
    attemptId,
    questionId,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 统一 JSON 请求块（GET/POST） */
async function req(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST",
  path: string,
  cookie: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 合法创建请求体（可覆盖字段） */
function createBody(
  attemptId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId,
    questionId: "q-alpha",
    question: "这道题的思路是什么？",
    channel: "inapp",
    materials: { annotation: true, draft: false, formalInk: false },
    mutationId: randomUUID(),
    ...over,
  };
}

/** 经路由创建一个任务，返回任务 id */
async function createTaskViaRoute(
  w: ReturnType<typeof world>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId, over),
  );
  expect(res.status).toBe(201);
  const body = aiTaskOkSchema.parse(await res.json());
  return body.data.id;
}

/** 学生策略覆盖（null = 清除恢复开放） */
function setStudentPolicy(
  db: ReturnType<typeof createTestDb>,
  mode: "post_submit_only" | null,
): void {
  db.delete(aiPolicyOverrides)
    .where(
      and(
        eq(aiPolicyOverrides.subjectType, "student"),
        eq(aiPolicyOverrides.subjectId, "s-a"),
      ),
    )
    .run();
  if (mode !== null) {
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: "s-a",
        mode,
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

/** 错误壳断言：状态码 + 错误码，返回壳（可续查中文消息） */
async function expectErr(
  res: Response,
  status: number,
  code: string,
): Promise<ApiErr> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErr;
  expect(body.error).toBe(code);
  return body;
}

// ---------- ① 四态：每个受保护路由 ----------

/** 受保护路由清单（方法 + 路径 + 合法请求体；路径含随机任务 id） */
function protectedPaths(): ["GET" | "POST", string, unknown?][] {
  const id = randomUUID();
  return [
    ["POST", "/api/student/ai/tasks", createBody(randomUUID())],
    ["GET", "/api/student/ai/tasks"],
    ["GET", `/api/student/ai/tasks/${id}`],
    ["POST", `/api/student/ai/tasks/${id}/update-pending`, {}],
    ["POST", `/api/student/ai/tasks/${id}/cancel`],
    ["POST", `/api/student/ai/tasks/${id}/resume`],
    ["POST", `/api/student/ai/tasks/${id}/retry`],
    ["POST", `/api/student/ai/tasks/${id}/opened`],
    ["GET", "/api/student/ai/queue-summary"],
  ];
}

it("无会话：全部任务路由 401 UNAUTHORIZED", async () => {
  const { app } = world();
  for (const [method, path, body] of protectedPaths()) {
    const res = await req(app, method, path, undefined, body);
    expect(res.status, `${method} ${path}`).toBe(401);
    expect(((await res.json()) as ApiErr).error, path).toBe("UNAUTHORIZED");
  }
});

it("教师 Cookie：访问学生任务路由同样 401（对称隔离）", async () => {
  const w = world();
  for (const [method, path, body] of protectedPaths()) {
    const res = await req(
      w.app,
      method,
      path,
      w.teacher,
      method === "POST" && path === "/api/student/ai/tasks"
        ? createBody(w.attemptId)
        : body,
    );
    expect(res.status, `${method} ${path}`).toBe(401);
    expect(((await res.json()) as ApiErr).error, path).toBe("UNAUTHORIZED");
  }
});

it("参数错误：create/list/update-pending 各 400 VALIDATION_ERROR，不落库", async () => {
  const w = world();

  // create：缺问题 / 未知越权字段（teacherId/policy）→ strict 拒绝；
  // 空白问题 → 文本域错误 AI_TEXT_TOO_LONG（§9 限额表分流）
  for (const [bad, code] of [
    [{ question: undefined }, "VALIDATION_ERROR"],
    [{ question: "   " }, "AI_TEXT_TOO_LONG"],
    [{ teacherId: TEST_TEACHER_ID }, "VALIDATION_ERROR"],
    [{ policy: "open_study" }, "VALIDATION_ERROR"],
    [{ channel: "sms" }, "VALIDATION_ERROR"],
    [{ mutationId: undefined }, "VALIDATION_ERROR"],
  ] as const) {
    const res = await req(
      w.app,
      "POST",
      "/api/student/ai/tasks",
      w.a,
      createBody(w.attemptId, bad),
    );
    await expectErr(res, 400, code);
  }
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0);

  // list：limit=0 / limit 非数字 / status 非法 / cursor 非法
  for (const qs of ["?limit=0", "?limit=abc", "?status=weird", "?cursor=!!!"]) {
    const res = await req(w.app, "GET", `/api/student/ai/tasks${qs}`, w.a);
    await expectErr(res, 400, "VALIDATION_ERROR");
  }

  // update-pending：空白问题 → 文本域 AI_TEXT_TOO_LONG；未知字段（自报归属）
  // → strict 拒绝 VALIDATION_ERROR
  const id = await createTaskViaRoute(w);
  for (const [bad, code] of [
    [{ question: "  " }, "AI_TEXT_TOO_LONG"],
    [{ studentId: "s-b" }, "VALIDATION_ERROR"],
  ] as const) {
    const res = await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${id}/update-pending`,
      w.a,
      bad,
    );
    await expectErr(res, 400, code);
  }
});

// ---------- ② create：参考在上下文 / 禁用拒绝无副作用 / 幂等 ----------

it("正常 schema：create 201 + 契约解析 + 泄露断言；库内快照确实含答案解析（双断言）", async () => {
  const w = world();
  const mutationId = randomUUID();
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId, { mutationId }),
  );
  expect(res.status).toBe(201);
  const raw = await res.json();
  const body = aiTaskOkSchema.parse(raw);
  assertNoLeak(body);
  const task = body.data;
  expect(task.status).toBe("created");
  expect(task.beforeSubmit).toBe(true); // draft 卷未交卷 → 服务端判定提交前
  expect(task.allowedActions).toContain("cancel");
  expect(task.question).toBe("这道题的思路是什么？");
  expect(task.materials).toEqual([]);
  // 响应原文无答案/解析/跨题/私注哨兵（公开视图结构上不含快照）
  const text = JSON.stringify(raw);
  for (const sentinel of [
    "其他题干哨兵BETA",
    "其他题解析哨兵BETA",
    "教师私注哨兵TC",
    SECRET_SENTINEL,
  ])
    expect(text.includes(sentinel), sentinel).toBe(false);

  // 双断言另一半（AGENTS.md AI 例外）：允许场景下答案解析确实进入外发载荷
  // ——快照存库即创建时的固定外发内容（dispatch worker 归 SAI-17）
  const row = w.db.select().from(aiTasks).all().at(0);
  if (row === undefined) throw new Error("任务行未落库");
  const snapshot = JSON.parse(row.contextSnapshotJson) as Record<
    string,
    unknown
  >;
  expect(String(snapshot.solutionMd)).toBe("解析");
  expect(String(snapshot.referenceAnswerMd)).toBe("B"); // 选项 1 → B
  expect(row.mutationId).toBe(mutationId);
});

it("create 幂等：同 mutationId 重放返回原任务（200），不新增行", async () => {
  const w = world();
  const mutationId = randomUUID();
  const first = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId, { mutationId }),
  );
  expect(first.status).toBe(201);
  const firstData = aiTaskOkSchema.parse(await first.json()).data;
  const second = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId, { mutationId }),
  );
  expect(second.status).toBe(200); // 重放非新建
  const secondData = aiTaskOkSchema.parse(await second.json()).data;
  expect(secondData.id).toBe(firstData.id);
  expect(w.db.select().from(aiTasks).all()).toHaveLength(1);
});

it("知情门服务端强制（SAI-18 遗留①兑现）：无任何 active 连接直调 create 403，不落任务行不占配额", async () => {
  const w = world();
  // 构造无连接态（= 未跨过首次知情，status firstUseRequired 同口径）
  w.db.delete(aiConnections).where(eq(aiConnections.studentId, "s-a")).run();
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId),
  );
  const err = await expectErr(res, 403, "AI_SETUP_REQUIRED");
  expect(err.message).toContain("设置"); // 中文指引去完成连接设置
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0); // 不占同题/当日配额
});

it("link 通道未开放：直调 create 409 拒绝（服务端与客户端同口径，不产无人领取的僵尸任务）", async () => {
  const w = world();
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId, { channel: "link" }),
  );
  const err = await expectErr(res, 409, "AI_CHANNEL_UNSUPPORTED");
  expect(err.message).toContain("链接通道");
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0);
});

it("未完成禁用：post_submit_only 下 create 403 且无任务/文件副作用，错误为中文指引", async () => {
  const w = world();
  setStudentPolicy(w.db, "post_submit_only");
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId),
  );
  const err = await expectErr(res, 403, "AI_POLICY_DISABLED");
  expect(err.message).toContain("教学模式"); // 中文操作指引（说明为何不可用）
  expect(JSON.stringify(err).includes(SECRET_SENTINEL)).toBe(false);
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0);
  const materialsDir = join(w.dataDir, "blobs", "ai-materials");
  expect(existsSync(materialsDir)).toBe(false); // 无文件副作用
});

it("仅打开页面不创建：list/detail/queue-summary 全零且不落任务行", async () => {
  const w = world();
  const list = await req(w.app, "GET", "/api/student/ai/tasks", w.a);
  expect(list.status).toBe(200);
  const listBody = aiTaskListOkSchema.parse(await list.json());
  assertNoLeak(listBody);
  expect(listBody.data.tasks).toEqual([]);
  expect(listBody.data.nextCursor).toBeNull();

  const missing = await req(
    w.app,
    "GET",
    `/api/student/ai/tasks/${randomUUID()}`,
    w.a,
  );
  await expectErr(missing, 404, "NOT_FOUND");

  const summary = await req(w.app, "GET", "/api/student/ai/queue-summary", w.a);
  expect(summary.status).toBe(200);
  const summaryBody = aiQueueSummaryOkSchema.parse(await summary.json());
  assertNoLeak(summaryBody);
  expect(summaryBody.data).toEqual({
    pendingCount: 0,
    processingCount: 0,
    unreadReplyCount: 0,
  });
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0);
});

// ---------- ③ list/detail：跨账号 / 禁用不泄待交付回信 ----------

it("list：本人范围过滤 + limit/游标不重不漏 + attemptId 筛选", async () => {
  const w = world();
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++)
    ids.add(
      await createTaskViaRoute(w, {
        question: `第 ${i + 1} 问`,
        channel: "mcp",
      }),
    );
  // B 学生建 1 个（自己的卷）
  const bAttempt = insertAttempt(w.db, { studentId: "s-b" });
  insertResponse(w.db, bAttempt, "q-alpha");
  const bRes = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.b,
    createBody(bAttempt),
  );
  expect(bRes.status).toBe(201);

  // 排序键 createdAt 同毫秒时退到 id——断言按集合不重不漏，不依赖创建顺序
  const page1 = aiTaskListOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/tasks?limit=2", w.a)
    ).json(),
  );
  assertNoLeak(page1);
  expect(page1.data.tasks).toHaveLength(2);
  expect(page1.data.nextCursor).toBeTypeOf("string");
  const page2 = aiTaskListOkSchema.parse(
    await (
      await req(
        w.app,
        "GET",
        `/api/student/ai/tasks?limit=2&cursor=${page1.data.nextCursor}`,
        w.a,
      )
    ).json(),
  );
  expect(page2.data.tasks).toHaveLength(1);
  expect(page2.data.nextCursor).toBeNull();
  const listed = [
    ...page1.data.tasks.map((t) => t.id),
    ...page2.data.tasks.map((t) => t.id),
  ];
  expect(new Set(listed).size).toBe(3); // 不重
  expect([...ids].every((id) => listed.includes(id))).toBe(true); // 不漏

  const scoped = aiTaskListOkSchema.parse(
    await (
      await req(
        w.app,
        "GET",
        `/api/student/ai/tasks?attemptId=${w.attemptId}`,
        w.a,
      )
    ).json(),
  );
  expect(scoped.data.tasks).toHaveLength(3);
});

it("跨账号：B 看不到 A 的任务——detail 404 与不存在同文案，list 恒本人域", async () => {
  const w = world();
  const id = await createTaskViaRoute(w);
  const cross = await req(w.app, "GET", `/api/student/ai/tasks/${id}`, w.b);
  const crossErr = await expectErr(cross, 404, "NOT_FOUND");
  const missing = await req(
    w.app,
    "GET",
    `/api/student/ai/tasks/${randomUUID()}`,
    w.b,
  );
  const missingErr = await expectErr(missing, 404, "NOT_FOUND");
  expect(crossErr.message).toBe(missingErr.message); // 同文案防枚举
  // B 用 A 的 attemptId 过滤也只看到自己的（空），不是 A 的任务
  const bList = aiTaskListOkSchema.parse(
    await (
      await req(
        w.app,
        "GET",
        `/api/student/ai/tasks?attemptId=${w.attemptId}`,
        w.b,
      )
    ).json(),
  );
  expect(bList.data.tasks).toEqual([]);
});

const REPLY_SENTINEL = "回信正文哨兵-启发式讲解";

it("禁用不泄待交付回信：detail/list 无 assistant 正文；opened 403；恢复后可交付", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const { generation } = beginInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
  });
  completeInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
    generation,
    replyMd: REPLY_SENTINEL,
  });

  // 开放期：detail 可见回信正文（未打开 = 未读，但已可交付）
  const openView = aiTaskDetailOkSchema.parse(
    await (
      await req(w.app, "GET", `/api/student/ai/tasks/${taskId}`, w.a)
    ).json(),
  );
  assertNoLeak(openView);
  expect(
    openView.data.messages.some(
      (m) => m.role === "assistant" && m.contentMd === REPLY_SENTINEL,
    ),
  ).toBe(true);
  expect(openView.data.task.hasReply).toBe(true);
  expect(openView.data.task.replyDeliveredAt).toBeNull(); // 未读

  // 教师改 post_submit_only（未完成题）：待交付回信不再下发
  setStudentPolicy(w.db, "post_submit_only");
  const gated = await req(w.app, "GET", `/api/student/ai/tasks/${taskId}`, w.a);
  const gatedText = JSON.stringify(await gated.json());
  expect(gated.status).toBe(200); // 任务本体可见（保留输入与退出权）
  expect(gatedText.includes(REPLY_SENTINEL)).toBe(false);
  const gatedBody = aiTaskDetailOkSchema.parse(JSON.parse(gatedText));
  expect(gatedBody.data.messages.filter((m) => m.role === "assistant")).toEqual(
    [],
  );
  expect(gatedBody.data.task.hasReply).toBe(true); // 事实如实，内容暂不交付

  const listText = JSON.stringify(
    await (await req(w.app, "GET", "/api/student/ai/tasks", w.a)).json(),
  );
  expect(listText.includes(REPLY_SENTINEL)).toBe(false);

  const opened = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/opened`,
    w.a,
  );
  await expectErr(opened, 403, "AI_POLICY_DISABLED");

  // 恢复开放：正文恢复交付，打开置 replyDeliveredAt（处理状态仍是 replied）
  setStudentPolicy(w.db, null);
  const ok = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/opened`,
    w.a,
  );
  expect(ok.status).toBe(200);
  const okBody = aiTaskOkSchema.parse(await ok.json());
  assertNoLeak(okBody);
  expect(okBody.data.status).toBe("replied"); // 查看不是状态转换
  expect(okBody.data.replyDeliveredAt).not.toBeNull();
});

// ---------- ④ update / retry ----------

it("update-pending：已领取不能更新（409）；created 显式更新换上下文版本与问题", async () => {
  const w = world();
  const claimedId = await createTaskViaRoute(w, { channel: "mcp" });
  claimMcpTask(w.db, { studentId: "s-a", taskId: claimedId });
  const claimedRes = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${claimedId}/update-pending`,
    w.a,
    { question: "改写的问题" },
  );
  await expectErr(claimedRes, 409, "AI_STATE_CONFLICT");

  const pendingId = await createTaskViaRoute(w);
  const before = aiTaskDetailOkSchema.parse(
    await (
      await req(w.app, "GET", `/api/student/ai/tasks/${pendingId}`, w.a)
    ).json(),
  ).data.task;
  // 学生先改答案 → 快照实质变化 → 显式更新产生新上下文版本
  w.db
    .update(responses)
    .set({ answerJson: JSON.stringify({ kind: "choice", index: 0 }) })
    .where(
      and(
        eq(responses.attemptId, w.attemptId),
        eq(responses.questionId, "q-alpha"),
      ),
    )
    .run();
  const updated = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${pendingId}/update-pending`,
    w.a,
    { question: "改写后的问题" },
  );
  expect(updated.status).toBe(200);
  const updatedBody = aiTaskOkSchema.parse(await updated.json());
  assertNoLeak(updatedBody);
  expect(updatedBody.data.contextVersion).not.toBe(before.contextVersion);
  expect(updatedBody.data.question).toBe("改写后的问题");
  // 无 body 也合法（仅刷新快照，不改问题）
  const refreshOnly = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${pendingId}/update-pending`,
    w.a,
    {},
  );
  expect(refreshOnly.status).toBe(200);
});

it("retry：显式动作——退避期内 409、过退避后 created+retryCount+1、非 failed 409", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  // 前置：非 failed 态重试 → 409
  const early = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/retry`,
    w.a,
  );
  await expectErr(early, 409, "AI_STATE_CONFLICT");

  const { generation } = beginInappDispatch(w.db, { studentId: "s-a", taskId });
  failInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
    generation,
    errorText: "连接超时",
    kind: "retryable",
  });
  const immediate = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/retry`,
    w.a,
  );
  const err = await expectErr(immediate, 409, "AI_STATE_CONFLICT");
  expect(err.message).toContain("重试"); // 中文指引（含稍候提示）

  // 服务层退避以失败时刻起算：测试把 updatedAt 回拨越过退避窗口
  w.db
    .update(aiTasks)
    .set({ updatedAt: new Date(Date.now() - 120_000).toISOString() })
    .where(eq(aiTasks.id, taskId))
    .run();
  const ok = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/retry`,
    w.a,
  );
  expect(ok.status).toBe(200);
  const okBody = aiTaskOkSchema.parse(await ok.json());
  assertNoLeak(okBody);
  expect(okBody.data.status).toBe("created");
  expect(okBody.data.retryCount).toBe(1);
  expect(okBody.data.errorText).toBeNull();
});

// ---------- ⑤ cancel / opened ----------

it("cancel：claimed 可取消（状态 cancelled + 事实保留）——不能替别人取消", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w, { channel: "mcp" });
  claimMcpTask(w.db, { studentId: "s-a", taskId });
  // B 替 A 取消 → 404 同文案
  const cross = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/cancel`,
    w.b,
  );
  await expectErr(cross, 404, "NOT_FOUND");
  expect(
    w.db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).all()[0]?.status,
  ).toBe("claimed");

  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/cancel`,
    w.a,
  );
  expect(res.status).toBe(200);
  const body = aiTaskOkSchema.parse(await res.json());
  assertNoLeak(body);
  expect(body.data.status).toBe("cancelled");
  const row = w.db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.id, taskId))
    .all()
    .at(0);
  if (row === undefined) throw new Error("任务行未落库");
  expect(row.cancelRequestedAt).not.toBeNull(); // claimed 取消 = 阻止交付标记
  // 事实与处理状态分开：cancelled 事实落库（append-only），含 wasClaimed
  const factRows = w.db
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "cancelled")))
    .all();
  expect(factRows).toHaveLength(1);
  expect(JSON.parse(factRows[0]?.detailJson ?? "{}").wasClaimed).toBe(true);

  // 已取消再取消 → 409（幂等的是重放语义，不是重复动作）
  const again = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/cancel`,
    w.a,
  );
  await expectErr(again, 409, "AI_STATE_CONFLICT");
});

it("opened：事实与处理状态分开、幂等；不能替别人标已读；未回信 409", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const { generation } = beginInappDispatch(w.db, { studentId: "s-a", taskId });
  completeInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
    generation,
    replyMd: REPLY_SENTINEL,
  });

  // 未回信任务打开 → 409
  const otherId = await createTaskViaRoute(w, { question: "第二问" });
  const noReply = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${otherId}/opened`,
    w.a,
  );
  await expectErr(noReply, 409, "AI_STATE_CONFLICT");

  // B 替 A 打开 → 404
  const cross = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/opened`,
    w.b,
  );
  await expectErr(cross, 404, "NOT_FOUND");

  const first = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/opened`,
    w.a,
  );
  expect(first.status).toBe(200);
  const firstBody = aiTaskOkSchema.parse(await first.json());
  const deliveredAt = firstBody.data.replyDeliveredAt;
  expect(deliveredAt).not.toBeNull();
  expect(firstBody.data.status).toBe("replied");
  // 重复打开幂等：时刻不变、事实不重复
  const second = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/opened`,
    w.a,
  );
  expect(second.status).toBe(200);
  expect(aiTaskOkSchema.parse(await second.json()).data.replyDeliveredAt).toBe(
    deliveredAt,
  );
  const deliveredFacts = w.db
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "reply_delivered")))
    .all();
  expect(deliveredFacts).toHaveLength(1);
});

// ---------- ⑥ 错误 / 附件：不带其他题、私注、真实路径或 secret ----------

it("附件元数据无内部路径；detail/summary 响应无跨题/私注/路径/密钥哨兵", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  attachAiTaskMaterials(w.db, w.dataDir, {
    studentId: "s-a",
    taskId,
    pages: [
      {
        kind: "annotation",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(),
      },
    ],
  });
  const res = await req(w.app, "GET", `/api/student/ai/tasks/${taskId}`, w.a);
  expect(res.status).toBe(200);
  const raw = await res.json();
  const body = aiTaskDetailOkSchema.parse(raw);
  assertNoLeak(body);
  expect(body.data.task.materials).toHaveLength(1);
  expect(body.data.task.materials[0]?.kind).toBe("annotation");
  expect(body.data.task.materials[0]?.state).toBe("ready");
  // 事实为学生投影：无 detailJson 内容
  expect(body.data.facts.every((f) => Object.keys(f).length === 5)).toBe(true);
  expect(body.data.facts.map((f) => f.type)).toContain("task_created");

  const text = JSON.stringify(raw);
  for (const sentinel of [
    "pngPath",
    "png_path",
    "blobs",
    "ai-materials",
    w.dataDir.replaceAll("\\", "/"),
    "其他题干哨兵BETA",
    "其他题解析哨兵BETA",
    "教师私注哨兵TC",
    "其他题考点哨兵BETA",
    SECRET_SENTINEL,
  ])
    expect(text.includes(sentinel), sentinel).toBe(false);

  // 错误响应同样不回显参考/路径/密钥
  setStudentPolicy(w.db, "post_submit_only");
  const errRes = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId),
  );
  const errText = JSON.stringify(await errRes.json());
  for (const sentinel of [
    "blobs",
    w.dataDir.replaceAll("\\", "/"),
    "教师私注哨兵TC",
    SECRET_SENTINEL,
  ])
    expect(errText.includes(sentinel), sentinel).toBe(false);
  // 附件文件确实存在（材料本体落盘了，只是路径不透出）
  expect(readdirSync(join(w.dataDir, "blobs", "ai-materials")).length).toBe(1);
});

it("resume：paused 任务显式恢复（学生继续，不自动外发）", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  // 经服务层构造 paused（dispatch 前策略拦截语义，403）
  setStudentPolicy(w.db, "post_submit_only");
  let blocked = false;
  try {
    beginInappDispatch(w.db, { studentId: "s-a", taskId });
  } catch {
    blocked = true; // 预期：任务转 paused + 403（服务层既有语义）
  }
  expect(blocked).toBe(true);
  setStudentPolicy(w.db, null);
  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/resume`,
    w.a,
  );
  expect(res.status).toBe(200);
  const body = aiTaskOkSchema.parse(await res.json());
  assertNoLeak(body);
  expect(body.data.status).toBe("created");
  expect(body.data.allowedActions).toContain("dispatch"); // 恢复后仍需显式发送
  // 非 paused 态 resume → 409
  const again = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/resume`,
    w.a,
  );
  await expectErr(again, 409, "AI_STATE_CONFLICT");
});

// ---------- app.ts 正文限额 ----------

it("正文限额：create 超入口预检线 413，不进 JSON 解析", async () => {
  const w = world();
  const res = await req(
    w.app,
    "POST",
    "/api/student/ai/tasks",
    w.a,
    createBody(w.attemptId),
    { "content-length": String(64 * 1024 + 1) },
  );
  await expectErr(res, 413, "AI_TEXT_TOO_LONG");
  expect(w.db.select().from(aiTasks).all()).toHaveLength(0);
});
