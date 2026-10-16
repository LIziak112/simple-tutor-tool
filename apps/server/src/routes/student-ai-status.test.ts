import { randomUUID } from "node:crypto";
import type { ApiErr } from "@tutor/contract";
import { aiStatusOkSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import {
  aiConnections,
  aiPolicyOverrides,
  aiTasks,
  attempts,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * SAI-20 学生单题状态路由测试（B11；GET /api/student/ai/status，B00 §4.2）。
 *
 * 状态接口是伴学栏/发送控制器的唯一服务端裁决来源：有效模式与原因、本题
 * 完成态、默认通道与连接态、首次知情门槛、本题任务摘要。覆盖：
 * ① 四态（无会话 401 / 教师 Cookie 401 / 参数错误 400 / 正常 schema）；
 * ② 裁决与完成态（默认开放、post_submit_only 作答中不可用、交卷后完成
 *    → 恒 open_study reason=completed——教师刚改设置立即生效即重新查询）；
 * ③ 连接态三档（未配置 firstUseRequired、已配置 ready、needs_rekey 不 ready）；
 * ④ 本题任务摘要（total/active/unreadReplies 按题隔离，邻题不计入）；
 * ⑤ GET 零副作用（不落任务行/连接行）+ 响应过 assertNoLeak。
 */

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  db.insert(students)
    .values({
      id: "s-a",
      teacherId: TEST_TEACHER_ID,
      displayName: "s-a",
      loginName: "s-a",
      linkToken: "s-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const attemptId = insertAttempt(db, { studentId: "s-a" });
  insertResponse(db, attemptId, "q-alpha");
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  return {
    app,
    db,
    attemptId,
    a: `tutor_student_session=${createStudentSession(db, "s-a").token}`,
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

function statusPath(attemptId: string, questionId = "q-alpha"): string {
  return `/api/student/ai/status?attemptId=${attemptId}&questionId=${questionId}`;
}

async function get(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie: string | undefined,
): Promise<Response> {
  return app.request(path, {
    method: "GET",
    headers: cookie === undefined ? {} : { cookie },
  });
}

/** 经连接路由创建一个页内连接（isDefault 默认 true——首个连接自动默认） */
async function createInappConnection(
  w: ReturnType<typeof world>,
  over: Record<string, unknown> = {},
): Promise<void> {
  const res = await w.app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie: w.a, "content-type": "application/json" },
    body: JSON.stringify({
      channel: "inapp",
      baseUrl: "https://api.example.com/v1",
      model: "glm-4",
      apiKey: "sk-plain-test-key",
      isDefault: true,
      ...over,
    }),
  });
  expect(res.status).toBe(201);
}

/** 学生策略覆盖（null = 清除） */
function setStudentPolicy(
  db: ReturnType<typeof createTestDb>,
  mode: "post_submit_only" | null,
): void {
  db.delete(aiPolicyOverrides)
    .where(eq(aiPolicyOverrides.subjectId, "s-a"))
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

/** 经路由创建一个任务（channel 可覆盖），返回响应 */
async function createTaskViaRoute(
  w: ReturnType<typeof world>,
  over: Record<string, unknown> = {},
): Promise<Response> {
  return w.app.request("/api/student/ai/tasks", {
    method: "POST",
    headers: { cookie: w.a, "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: w.attemptId,
      questionId: "q-alpha",
      question: "这道题的思路是什么？",
      channel: "inapp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
      ...over,
    }),
  });
}

/** 错误壳断言 */
async function expectErr(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErr;
  expect(body.error).toBe(code);
}

// ---------- ① 四态 ----------

it("无会话：状态路由 401 UNAUTHORIZED", async () => {
  const { app, attemptId } = world();
  await expectErr(
    await get(app, statusPath(attemptId), undefined),
    401,
    "UNAUTHORIZED",
  );
});

it("教师 Cookie：访问学生状态路由同样 401（对称隔离）", async () => {
  const { app, attemptId, teacher } = world();
  await expectErr(
    await get(app, statusPath(attemptId), teacher),
    401,
    "UNAUTHORIZED",
  );
});

it("参数错误：缺 questionId / attemptId 非法 400 VALIDATION_ERROR", async () => {
  const { app, attemptId, a } = world();
  await expectErr(
    await get(app, `/api/student/ai/status?attemptId=${attemptId}`, a),
    400,
    "VALIDATION_ERROR",
  );
  await expectErr(
    await get(
      app,
      "/api/student/ai/status?attemptId=not-a-uuid&questionId=q",
      a,
    ),
    400,
    "VALIDATION_ERROR",
  );
});

it("他卷/他题：不存在同文案 404，不泄露存在性", async () => {
  const { app, attemptId, a } = world();
  await expectErr(
    await get(app, statusPath(attemptId, "q-missing"), a),
    404,
    "QUESTION_NOT_FOUND",
  );
  await expectErr(
    await get(app, statusPath(randomUUID()), a),
    404,
    "ATTEMPT_NOT_FOUND",
  );
});

// ---------- ② 裁决与完成态 ----------

it("默认开放伴学：usable + open_study，未交卷 completed=false；未配置连接 firstUseRequired", async () => {
  const w = world();
  const res = await get(w.app, statusPath(w.attemptId), w.a);
  expect(res.status).toBe(200);
  const body = aiStatusOkSchema.parse(await res.json());
  expect(body.data.resolution).toEqual({
    usable: true,
    mode: "open_study",
    reason: "teacher_default",
  });
  expect(body.data.completed).toBe(false);
  expect(body.data.channelDefault).toBeNull();
  expect(body.data.connectionReady).toBe(false);
  expect(body.data.firstUseRequired).toBe(true);
  expect(body.data.taskSummary).toEqual({
    total: 0,
    active: 0,
    unreadReplies: 0,
  });
});

it("post_submit_only 覆盖：作答中 usable=false 带原因；交卷后 completed → 恒 open_study", async () => {
  const w = world();
  setStudentPolicy(w.db, "post_submit_only");
  const answering = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(answering.data.resolution.usable).toBe(false);
  expect(answering.data.resolution.reason).toBe("student_closed");
  expect(answering.data.resolution.mode).toBeUndefined();
  // 交卷（assignment 来源按整卷状态判完成）
  w.db
    .update(attempts)
    .set({ status: "submitted" })
    .where(eq(attempts.id, w.attemptId))
    .run();
  const completed = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(completed.data.completed).toBe(true);
  expect(completed.data.resolution).toEqual({
    usable: true,
    mode: "open_study",
    reason: "completed",
  });
});

// ---------- ③ 连接态 ----------

it("配置页内连接后：channelDefault=inapp、ready、不再要求首次知情", async () => {
  const w = world();
  await createInappConnection(w);
  const body = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(body.data.channelDefault).toBe("inapp");
  expect(body.data.connectionReady).toBe(true);
  expect(body.data.firstUseRequired).toBe(false);
});

it("默认连接 needs_rekey：connectionReady=false 但仍属已知情（firstUseRequired=false）", async () => {
  const w = world();
  await createInappConnection(w);
  // 密钥不可解：直接改 verifyStatus 模拟密封密钥轮换后的 needs_rekey 态
  w.db
    .update(aiConnections)
    .set({ verifyStatus: "needs_rekey" })
    .where(eq(aiConnections.studentId, "s-a"))
    .run();
  const body = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(body.data.channelDefault).toBe("inapp");
  expect(body.data.connectionReady).toBe(false);
  expect(body.data.firstUseRequired).toBe(false);
});

// ---------- ④ 本题任务摘要 ----------

it("本题任务摘要：创建后 total/active 计入，他题任务不计入", async () => {
  const w = world();
  await createInappConnection(w);
  // 邻题任务（q-beta 同卷）：不应计入本题摘要
  insertResponse(w.db, w.attemptId, "q-beta");
  expect(
    (
      await createTaskViaRoute(w, {
        questionId: "q-beta",
        question: "邻题求助",
      })
    ).status,
  ).toBe(201);
  const before = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(before.data.taskSummary).toEqual({
    total: 0,
    active: 0,
    unreadReplies: 0,
  });
  // 本题任务
  expect((await createTaskViaRoute(w)).status).toBe(201);
  const after = aiStatusOkSchema.parse(
    await (await get(w.app, statusPath(w.attemptId), w.a)).json(),
  );
  expect(after.data.taskSummary).toEqual({
    total: 1,
    active: 1,
    unreadReplies: 0,
  });
});

// ---------- ⑤ 零副作用与泄露 ----------

it("GET 零副作用：重复查询不落任务/连接行；响应无答案/私注/跨题哨兵", async () => {
  const w = world();
  for (let i = 0; i < 3; i += 1) {
    const res = await get(w.app, statusPath(w.attemptId), w.a);
    expect(res.status).toBe(200);
  }
  const taskRows = w.db.select().from(aiTasks).all();
  expect(taskRows).toHaveLength(0);
  const connectionRows = w.db.select().from(aiConnections).all();
  expect(connectionRows).toHaveLength(0);
  const res = await get(w.app, statusPath(w.attemptId), w.a);
  assertNoLeak(await res.json());
});
