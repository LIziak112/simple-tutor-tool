import { randomUUID } from "node:crypto";
import type { ApiErr } from "@tutor/contract";
import {
  aiQueueSummaryOkSchema,
  aiTaskListOkSchema,
  aiTaskOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import { students, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  beginInappDispatch,
  completeInappDispatch,
  failInappDispatch,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * SAI-23 全局队列与归档路由测试（B12 批次「先测」路由侧，B00 §4.2 API 表）。
 *
 * - GET /api/student/ai/tasks 的 archived 三态过滤经查询参数白名单解析
 *   （exclude 默认队列 / only 已归档 / 缺省全部），全局列表附 origins 来源
 *   摘要（标题/题号/导航键），他学生任务不进本人列表；
 * - POST /api/student/ai/tasks/:id/archive：终态可归档（归档≠已读——
 *   status/replyDeliveredAt 不动、unreadReplyCount 不减）、在途/可重试
 *   （created/failed）409 AI_STATE_CONFLICT、他学生 404 同文案防枚举、
 *   无会话/教师 Cookie 401；
 * - 游标分页：createdAt+id 双键翻页不重不漏；
 * - GET /api/student/ai/queue-summary 双计数：待领取与未读回信语义分开。
 *
 * 全部学生可读响应过 assertNoLeak（AGENTS.md 硬规则 3）。
 */

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
  insertResponse(db, attemptId, "q-alpha");
  insertResponse(db, attemptId, "q-beta");
  for (const studentId of ["s-a", "s-b"])
    insertAiConnectionFixture(db, studentId);
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
    attemptId,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

async function req(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST",
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 经路由创建任务（默认 inapp 通道 q-alpha），返回任务 id */
async function createTaskViaRoute(
  w: ReturnType<typeof world>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await req(w.app, "POST", "/api/student/ai/tasks", w.a, {
    attemptId: w.attemptId,
    questionId: "q-alpha",
    question: "这道题的思路是什么？",
    channel: "inapp",
    materials: { annotation: true, draft: false, formalInk: false },
    mutationId: randomUUID(),
    ...over,
  });
  expect(res.status).toBe(201);
  const body = aiTaskOkSchema.parse(await res.json());
  return body.data.id;
}

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

it("四态：无会话/教师 Cookie 对列表与归档 401；他学生归档 404 同文案防枚举", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  // 无会话
  await expectErr(
    await req(w.app, "GET", "/api/student/ai/tasks?archived=only", undefined),
    401,
    "UNAUTHORIZED",
  );
  await expectErr(
    await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${taskId}/archive`,
      undefined,
    ),
    401,
    "UNAUTHORIZED",
  );
  // 教师 Cookie 不是学生会话
  await expectErr(
    await req(w.app, "GET", "/api/student/ai/tasks", w.teacher),
    401,
    "UNAUTHORIZED",
  );
  // 他学生：列表不可见 + 归档 404 同文案（与不存在 id 同文案防枚举）
  const strangerList = aiTaskListOkSchema.parse(
    await (await req(w.app, "GET", "/api/student/ai/tasks", w.b)).json(),
  );
  expect(strangerList.data.tasks.map((t) => t.id)).not.toContain(taskId);
  const strangerErr = await expectErr(
    await req(w.app, "POST", `/api/student/ai/tasks/${taskId}/archive`, w.b),
    404,
    "NOT_FOUND",
  );
  const ghostErr = await expectErr(
    await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${randomUUID()}/archive`,
      w.b,
    ),
    404,
    "NOT_FOUND",
  );
  // 同文案防枚举：他人任务与不存在的任务不可区分
  expect(strangerErr.message).toBe(ghostErr.message);
});

it("归档≠已读：replied 归档后 status/replyDeliveredAt 不动、unread 不减、exclude/only 过滤生效", async () => {
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
    replyMd: "讲解内容",
  });
  const before = aiQueueSummaryOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/queue-summary", w.a)
    ).json(),
  );
  expect(before.data.unreadReplyCount).toBe(1);

  const res = await req(
    w.app,
    "POST",
    `/api/student/ai/tasks/${taskId}/archive`,
    w.a,
  );
  expect(res.status).toBe(200);
  const task = aiTaskOkSchema.parse(await res.json()).data;
  expect(task.status).toBe("replied"); // 归档不是状态转换
  expect(task.replyDeliveredAt).toBeNull(); // 归档不替学生「已读」
  expect(task.archivedAt).not.toBeNull();
  expect(task.allowedActions).toContain("archive"); // 幂等重复归档仍可用

  // 未读计数不因归档减少（只有 opened 才交付）
  const after = aiQueueSummaryOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/queue-summary", w.a)
    ).json(),
  );
  expect(after.data.unreadReplyCount).toBe(1);

  // exclude 默认队列视图隐藏；only 只看已归档；缺省全部
  const queue = aiTaskListOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/tasks?archived=exclude", w.a)
    ).json(),
  );
  expect(queue.data.tasks.map((t) => t.id)).toEqual([]);
  const archivedOnly = aiTaskListOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/tasks?archived=only", w.a)
    ).json(),
  );
  expect(archivedOnly.data.tasks.map((t) => t.id)).toEqual([taskId]);
  assertNoLeak(archivedOnly);
  // 非法枚举值拒绝（400）
  await expectErr(
    await req(w.app, "GET", "/api/student/ai/tasks?archived=some", w.a),
    400,
    "VALIDATION_ERROR",
  );
});

it("在途/可重试不可归档：created 与 failed 409 AI_STATE_CONFLICT", async () => {
  const w = world();
  const createdId = await createTaskViaRoute(w, { channel: "inapp" });
  await expectErr(
    await req(w.app, "POST", `/api/student/ai/tasks/${createdId}/archive`, w.a),
    409,
    "AI_STATE_CONFLICT",
  );
  // failed：dispatch 失败后可重试，归档会丢重试入口
  const failedId = await createTaskViaRoute(w, {
    channel: "inapp",
    questionId: "q-beta",
  });
  const { generation } = beginInappDispatch(w.db, {
    studentId: "s-a",
    taskId: failedId,
  });
  failInappDispatch(w.db, {
    studentId: "s-a",
    taskId: failedId,
    generation,
    errorText: "超时",
    kind: "retryable",
  });
  await expectErr(
    await req(w.app, "POST", `/api/student/ai/tasks/${failedId}/archive`, w.a),
    409,
    "AI_STATE_CONFLICT",
  );
  // failed 任务在全局列表如实呈现，allowedActions 不含 archive（含 retry）
  const list = aiTaskListOkSchema.parse(
    await (await req(w.app, "GET", "/api/student/ai/tasks", w.a)).json(),
  );
  const failedTask = list.data.tasks.find((t) => t.id === failedId);
  expect(failedTask?.status).toBe("failed");
  expect(failedTask?.allowedActions).not.toContain("archive");
  expect(failedTask?.allowedActions).toContain("retry");
  assertNoLeak(list);
});

it("游标分页：createdAt+id 双键翻页不重不漏；全局列表附 origins 摘要", async () => {
  const w = world();
  const [idA, idB, idC] = [
    await createTaskViaRoute(w),
    await createTaskViaRoute(w, { questionId: "q-beta" }),
    await createTaskViaRoute(w),
  ];
  const ids = [idA, idB, idC] as const;
  // 第一页 2 条（创建倒序）+ nextCursor
  const page1 = aiTaskListOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/tasks?limit=2", w.a)
    ).json(),
  );
  expect(page1.data.tasks.map((t) => t.id)).toEqual([ids[2], ids[1]]);
  expect(page1.data.nextCursor).not.toBeNull();
  assertNoLeak(page1);
  // origins 来源摘要：作业标题 + 冻结序题号 + 导航键
  const origin1 = page1.data.origins?.[ids[2]];
  expect(origin1).toMatchObject({
    sourceType: "assignment",
    attemptNo: 1,
    questionNo: 1, // q-alpha 是本卷第一题（冻结序）
    title: "作业",
    attemptStatus: "draft",
  });
  expect(origin1?.assignmentId).not.toBeNull();
  expect(page1.data.origins?.[ids[1]]?.questionNo).toBe(2); // q-beta 第二题
  // 第二页承接（不重不漏）
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
  expect(page2.data.tasks.map((t) => t.id)).toEqual([ids[0]]);
  expect(page2.data.nextCursor).toBeNull();
  assertNoLeak(page2);
});

it("queue-summary 双计数：待领取与未读回信分开（不是一个角标双语义）", async () => {
  const w = world();
  // t1：inapp 已回信未读；t2：created 待领取
  const t1 = await createTaskViaRoute(w);
  const t2 = await createTaskViaRoute(w, { questionId: "q-beta" });
  const { generation } = beginInappDispatch(w.db, {
    studentId: "s-a",
    taskId: t1,
  });
  completeInappDispatch(w.db, {
    studentId: "s-a",
    taskId: t1,
    generation,
    replyMd: "讲解",
  });
  const summary = aiQueueSummaryOkSchema.parse(
    await (
      await req(w.app, "GET", "/api/student/ai/queue-summary", w.a)
    ).json(),
  );
  expect(summary.data.pendingCount).toBe(1); // t2 created
  expect(summary.data.unreadReplyCount).toBe(1); // t1 replied 未打开
  expect(summary.data.processingCount).toBe(0);
  assertNoLeak(summary);
  // t2 归档被拒（created 在途）——计数语义不受影响
  await expectErr(
    await req(w.app, "POST", `/api/student/ai/tasks/${t2}/archive`, w.a),
    409,
    "AI_STATE_CONFLICT",
  );
});
