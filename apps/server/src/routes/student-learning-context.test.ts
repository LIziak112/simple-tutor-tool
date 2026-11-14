import { randomUUID } from "node:crypto";
import {
  DEVICE_ID_HEADER,
  DEVICE_INFO_HEADER,
  learningContextOkSchema,
  learningContextSchema,
  MEMO_METADATA_MAX_BYTES,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app";
import { createStudentSession } from "../auth/session";
import {
  attempts,
  courseItems,
  courseStudents,
  courses,
  devices,
  lectures,
  responses,
} from "../db/schema";
import {
  createTestDb,
  createTestDir,
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils";
import { submitAttempt } from "../services/attempt-whole-submit";
import { assertNoLeak } from "../test/assert-no-leak";
import { frozenDraftAttempt, snapshotJsonOf } from "../test/evidence-fixtures";
import { makeStudent } from "../test/note-fixtures";

function setup() {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { attemptId, rowIds } = frozenDraftAttempt(db, studentId, [
    {
      questionId: "q1",
      snapshotJson: snapshotJsonOf({ id: "q1", stemMd: "题目 [[秘密答案]]" }),
    },
    { questionId: "q2", snapshotJson: snapshotJsonOf({ id: "q2" }) },
  ]);
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const headers = {
    cookie: `tutor_student_session=${createStudentSession(db, studentId).token}`,
    "content-type": "application/json",
  };
  const target = {
    kind: "question",
    attemptId,
    questionId: "q2",
    surface: "attempt",
  };
  const resolve = (body: object = target, extra: Record<string, string> = {}) =>
    app.request("/api/student/learning-context/resolve", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  return { db, studentId, attemptId, rowIds, app, headers, target, resolve };
}
it("按本人公开展示序返回真实冻结坐标且不含题面/答案", async () => {
  const e = setup();
  const response = await e.resolve();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const raw = await response.json();
  const body = learningContextOkSchema.parse(raw);
  assertNoLeak(body);
  expect(JSON.stringify(body)).not.toContain("秘密答案");
  const context = learningContextSchema.parse(body.data);
  expect(context.session).toEqual({
    attemptId: e.attemptId,
    questionRevisionId: e.rowIds[1],
    questionNo: 2,
    questionCount: 2,
    settlementSeq: null,
  });
  expect(context.content.questionId).toBe("q2");
});
it("没有会话401，他人的作答/不存在题同为404", async () => {
  const e = setup();
  const missing = await e.app.request("/api/student/learning-context/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(e.target),
  });
  expect(missing.status).toBe(401);
  const other = makeStudent(e.db);
  const denied = await e.resolve(e.target, {
    cookie: `tutor_student_session=${createStudentSession(e.db, other).token}`,
  });
  const unknown = await e.resolve({ ...e.target, questionId: "unknown" });
  expect(denied.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(await denied.json()).toEqual(await unknown.json());
});
it("已核验题的 expected 冻结版本不符返回409", async () => {
  const e = setup();
  const r = await e.resolve({
    ...e.target,
    expectedQuestionRevisionId: randomUUID(),
  });
  expect(r.status).toBe(409);
  assertNoLeak(await r.json());
});
it("未知字段/伪阶段拒绝，不能凭 surface 获得答案", async () => {
  const e = setup();
  expect((await e.resolve({ ...e.target, activated: true })).status).toBe(400);
  const r = await e.resolve({ ...e.target, surface: "result" });
  expect(r.status).toBe(200);
  assertNoLeak(await r.json());
});
it("未声明长度的 JSON 流超元数据预算仍返回413", async () => {
  const e = setup();
  const chunk = new TextEncoder().encode(
    JSON.stringify({
      ...e.target,
      questionId: "长".repeat(MEMO_METADATA_MAX_BYTES),
    }),
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(chunk);
      c.close();
    },
  });
  const r = await e.app.request("/api/student/learning-context/resolve", {
    method: "POST",
    headers: e.headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  expect(r.status).toBe(413);
});
it("浏览器真实 deviceId 协议可保存完整 context，仍拒绝他人的设备", async () => {
  const e = setup();
  const canonical = await e.resolve();
  expect(canonical.status).toBe(200);
  const { data: context } = learningContextOkSchema.parse(
    await canonical.json(),
  );
  const deviceId = randomUUID();
  const response = await e.app.request("/api/student/memos", {
    method: "POST",
    headers: {
      ...e.headers,
      [MEMO_OUTBOX_ACCOUNT_HEADER]: e.studentId,
      [DEVICE_ID_HEADER]: deviceId,
      [DEVICE_INFO_HEADER]: JSON.stringify({
        deviceId,
        type: "desktop",
        os: "Linux",
        browser: "Chromium",
        standalone: false,
      }),
    },
    body: JSON.stringify({
      clientId: randomUUID(),
      text: "第二题记录",
      context: { ...context, deviceId },
      deviceId,
    }),
  });
  expect(response.status).toBe(201);
  const memo = memoOkSchema.parse(await response.json()).data;
  expect(memo.context?.session?.questionRevisionId).toBe(e.rowIds[1]);
  expect(memo.deviceId).toBe(deviceId);
  const other = makeStudent(e.db);
  const denied = await e.app.request("/api/student/memos", {
    method: "POST",
    headers: {
      ...e.headers,
      cookie: `tutor_student_session=${createStudentSession(e.db, other).token}`,
      [MEMO_OUTBOX_ACCOUNT_HEADER]: other,
    },
    body: JSON.stringify({
      clientId: randomUUID(),
      text: "另一人的记录",
      deviceId,
    }),
  });
  expect(denied.status).toBe(404);
});

function addVisibleCourse(
  e: ReturnType<typeof setup>,
  lectureId: string,
  title: string,
) {
  const id = randomUUID();
  e.db
    .insert(courses)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title,
      order: 0,
      createdAt: new Date().toISOString(),
    })
    .run();
  e.db
    .insert(courseStudents)
    .values({
      courseId: id,
      studentId: e.studentId,
      joinedAt: new Date().toISOString(),
    })
    .run();
  const itemId = randomUUID();
  e.db
    .insert(courseItems)
    .values({
      id: itemId,
      courseId: id,
      kind: "lecture",
      refId: lectureId,
      title: null,
      order: 0,
      visible: true,
      createdAt: new Date().toISOString(),
    })
    .run();
  return { id, itemId };
}
it("讲义明确选择B课程，新context保存仍是B且不能借A可见绕过隐藏B", async () => {
  const e = setup();
  const { lectureId } = seedLessonWithEmbeddedUnit(e.db);
  e.db
    .update(lectures)
    .set({ kind: "lecture" })
    .where(eq(lectures.id, lectureId))
    .run();
  addVisibleCourse(e, lectureId, "A课");
  const b = addVisibleCourse(e, lectureId, "B课");
  const r = await e.resolve({ kind: "lecture", lectureId, courseId: b.id });
  expect(r.status).toBe(200);
  const context = learningContextOkSchema.parse(await r.json()).data;
  expect(context.content.courseId).toBe(b.id);
  expect(context.content.titles.course).toBe("B课");
  expect(context.session).toBeNull();
  const memo = await e.app.request("/api/student/memos", {
    method: "POST",
    headers: { ...e.headers, [MEMO_OUTBOX_ACCOUNT_HEADER]: e.studentId },
    body: JSON.stringify({ clientId: randomUUID(), text: "来自B课", context }),
  });
  expect(memo.status).toBe(201);
  expect(
    memoOkSchema.parse(await memo.json()).data.context?.content.courseId,
  ).toBe(b.id);
  e.db
    .update(courseItems)
    .set({ visible: false })
    .where(eq(courseItems.id, b.itemId))
    .run();
  expect(
    (await e.resolve({ kind: "lecture", lectureId, courseId: b.id })).status,
  ).toBe(404);
});
it("讲练顺序与正文首现/孤儿题一致而非responses插入序", async () => {
  const e = setup();
  const { lectureId, unitId } = seedLessonWithEmbeddedUnit(e.db);
  e.db
    .update(lectures)
    .set({
      markdown:
        '# 讲练\n\n::::question{id="q2" type="fill"}\n第二题 [[秘密]]\n::::',
    })
    .where(eq(lectures.id, lectureId))
    .run();
  e.db
    .update(attempts)
    .set({ sourceType: "lesson", lectureId, unitId })
    .where(eq(attempts.id, e.attemptId))
    .run();
  e.db
    .update(responses)
    .set({ unitId })
    .where(eq(responses.attemptId, e.attemptId))
    .run();
  addVisibleCourse(e, lectureId, "讲练课");
  const r = await e.resolve({ ...e.target, surface: "lesson" });
  expect(r.status).toBe(200);
  const c = learningContextOkSchema.parse(await r.json()).data;
  expect(c.session?.questionRevisionId).toBe(e.rowIds[1]);
  expect(c.session?.questionNo).toBe(1);
  expect(c.session?.questionCount).toBe(2);
  const memo = await e.app.request("/api/student/memos", {
    method: "POST",
    headers: { ...e.headers, [MEMO_OUTBOX_ACCOUNT_HEADER]: e.studentId },
    body: JSON.stringify({
      clientId: randomUUID(),
      text: "正文第一题",
      context: c,
    }),
  });
  expect(memo.status).toBe(201);
});
it("公开投影跳过坏快照，题序/count不含缺失题且不挪用版本", async () => {
  const e = setup();
  e.db
    .update(responses)
    .set({ questionSnapshotJson: "{broken" })
    .where(eq(responses.id, e.rowIds[0] ?? ""))
    .run();
  const r = await e.resolve();
  expect(r.status).toBe(200);
  const c = learningContextOkSchema.parse(await r.json()).data;
  expect(c.session).toMatchObject({
    questionNo: 1,
    questionCount: 1,
    questionRevisionId: e.rowIds[1],
  });
  expect((await e.resolve({ ...e.target, questionId: "q1" })).status).toBe(404);
});
it("收尾后的projector实读真实seq，结算前同clientId重放仍保留原null快照", async () => {
  const e = setup();
  e.db
    .update(attempts)
    .set({ sourceType: "wrong", unitId: null })
    .where(eq(attempts.id, e.attemptId))
    .run();
  const before = learningContextOkSchema.parse(
    await (await e.resolve()).json(),
  ).data;
  expect(before.session?.settlementSeq).toBeNull();
  const clientId = randomUUID();
  const post = () =>
    e.app.request("/api/student/memos", {
      method: "POST",
      headers: { ...e.headers, [MEMO_OUTBOX_ACCOUNT_HEADER]: e.studentId },
      body: JSON.stringify({ clientId, text: "结算前记录", context: before }),
    });
  const saved = memoOkSchema.parse(await (await post()).json()).data;
  submitAttempt(e.db, e.studentId, e.attemptId);
  const after = learningContextOkSchema.parse(
    await (await e.resolve()).json(),
  ).data;
  expect(after.session?.settlementSeq).toBe(1);
  const replay = await post();
  expect(replay.status).toBe(200);
  expect(memoOkSchema.parse(await replay.json()).data).toEqual(saved);
  expect(saved.context?.session?.settlementSeq).toBeNull();
});

it("合法长DSL题id在请求预算内完整保留，真实坐标不受512字符截断", async () => {
  const e = setup();
  const questionId = "题".repeat(1000);
  e.db
    .update(responses)
    .set({
      questionId,
      questionSnapshotJson: snapshotJsonOf({ id: questionId }),
    })
    .where(eq(responses.id, e.rowIds[1] ?? ""))
    .run();
  const r = await e.resolve({ ...e.target, questionId });
  expect(r.status).toBe(200);
  const c = learningContextOkSchema.parse(await r.json()).data;
  expect(c.content.questionId).toBe(questionId);
  expect(c.session?.questionRevisionId).toBe(e.rowIds[1]);
  assertNoLeak(c);
});

it("跨单元分组后题号采用页面平铺顺序，版本仍对应目标题", async () => {
  const e = setup();
  const { attemptId, rowIds } = frozenDraftAttempt(e.db, e.studentId, [
    {
      questionId: "a1",
      unitId: "A",
      snapshotJson: snapshotJsonOf({ id: "a1" }),
    },
    {
      questionId: "b1",
      unitId: "B",
      snapshotJson: snapshotJsonOf({ id: "b1" }),
    },
    {
      questionId: "a2",
      unitId: "A",
      snapshotJson: snapshotJsonOf({ id: "a2" }),
    },
  ]);
  const r = await e.resolve({ ...e.target, attemptId, questionId: "b1" });
  expect(r.status).toBe(200);
  expect(
    learningContextOkSchema.parse(await r.json()).data.session,
  ).toMatchObject({
    questionRevisionId: rowIds[1],
    questionNo: 3,
    questionCount: 3,
  });
});

it("已冻结读取不start/restart/activate/settle，作废来源统一404", async () => {
  const e = setup();
  // 与既有取卷口径相同：遗留卷先经真实requireUsableAttempt懒冻结。
  expect((await e.resolve()).status).toBe(200);
  const readRows = () => ({
    attempt: e.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, e.attemptId))
      .get(),
    responses: e.db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, e.attemptId))
      .all(),
  });
  const before = readRows();
  expect((await e.resolve()).status).toBe(200);
  expect(readRows()).toEqual(before);
  e.db
    .update(attempts)
    .set({ abandonedAt: new Date().toISOString() })
    .where(eq(attempts.id, e.attemptId))
    .run();
  const r = await e.resolve();
  expect(r.status).toBe(404);
  assertNoLeak(await r.json());
});

it("canonical名称展开仍受共享元数据预算约束", async () => {
  const e = setup();
  const { lectureId } = seedLessonWithEmbeddedUnit(e.db);
  e.db
    .update(lectures)
    .set({ kind: "lecture", title: "长".repeat(MEMO_METADATA_MAX_BYTES) })
    .where(eq(lectures.id, lectureId))
    .run();
  const course = addVisibleCourse(e, lectureId, "课程");
  const r = await e.resolve({
    kind: "lecture",
    lectureId,
    courseId: course.id,
  });
  expect(r.status).toBe(413);
  assertNoLeak(await r.json());
});

function lessonEnvironment() {
  const e = setup();
  const { lectureId, unitId } = seedLessonWithEmbeddedUnit(e.db);
  e.db
    .update(lectures)
    .set({
      markdown:
        '# 讲练\n\n::::question{id="q2" type="fill"}\n第二题 [[私密答案]]\n::::',
    })
    .where(eq(lectures.id, lectureId))
    .run();
  const a = addVisibleCourse(e, lectureId, "A可见课程");
  const b = addVisibleCourse(e, lectureId, "B来源课程");
  e.db
    .update(attempts)
    .set({ sourceType: "lesson", lectureId, unitId, courseId: b.id })
    .where(eq(attempts.id, e.attemptId))
    .run();
  e.db
    .update(responses)
    .set({ unitId })
    .where(eq(responses.attemptId, e.attemptId))
    .run();
  return { ...e, lectureId, a, b };
}

it("无host的lesson成功canonical可原样createMemo，显式surface仍严格且旧快照优先", async () => {
  const e = lessonEnvironment();
  const response = await e.resolve({ ...e.target, surface: "lesson" });
  expect(response.status).toBe(200);
  const context = learningContextOkSchema.parse(await response.json()).data;
  expect(context.view).toBeNull();
  expect(context.session?.questionNo).toBe(1);
  const clientId = randomUUID();
  const post = (candidate = context, id = clientId) =>
    e.app.request("/api/student/memos", {
      method: "POST",
      headers: { ...e.headers, [MEMO_OUTBOX_ACCOUNT_HEADER]: e.studentId },
      body: JSON.stringify({
        clientId: id,
        text: "不补秘密view协议",
        context: candidate,
      }),
    });
  const saved = await post();
  expect(saved.status).toBe(201);
  const memo = memoOkSchema.parse(await saved.json()).data;
  expect(memo.context).toEqual(context);
  const view = {
    surface: "lesson" as const,
    layout: "list",
    viewId: randomUUID(),
  };
  const hosted = await post({ ...context, view }, randomUUID());
  expect(hosted.status).toBe(201);
  expect(memoOkSchema.parse(await hosted.json()).data.context?.view).toEqual(
    view,
  );
  const attemptProjection = learningContextOkSchema.parse(
    await (await e.resolve()).json(),
  ).data;
  expect(attemptProjection.session?.questionNo).toBe(2);
  expect((await post(attemptProjection, randomUUID())).status).toBe(201);
  const forcedAttempt = {
    ...context,
    view: { surface: "attempt" as const, layout: null, viewId: randomUUID() },
  };
  expect((await post(forcedAttempt, randomUUID())).status).toBe(404);
  const otherSurface = {
    ...context,
    view: { surface: "other" as const, layout: null, viewId: randomUUID() },
  };
  expect((await post(otherSurface, randomUUID())).status).toBe(404);
  e.db
    .update(courseItems)
    .set({ visible: false })
    .where(eq(courseItems.id, e.b.itemId))
    .run();
  const replay = await post();
  expect(replay.status).toBe(200);
  expect(memoOkSchema.parse(await replay.json()).data).toEqual(memo);
  expect((await e.resolve({ ...e.target, surface: "lesson" })).status).toBe(
    404,
  );
});

it.each([
  "hidden",
  "unpublished",
  "lost-membership",
  "deleted",
  "archived-course",
] as const)(
  "lesson排序必须在真实来源B课可见，A课可见不能绕过%s；历史冻结attempt/result仍可读",
  async (reason) => {
    const e = lessonEnvironment();
    expect((await e.resolve({ ...e.target, surface: "lesson" })).status).toBe(
      200,
    );
    if (reason === "hidden")
      e.db
        .update(courseItems)
        .set({ visible: false })
        .where(eq(courseItems.id, e.b.itemId))
        .run();
    else if (reason === "unpublished")
      e.db
        .update(courseItems)
        .set({ publishAt: "2999-01-01T00:00:00.000Z" })
        .where(eq(courseItems.id, e.b.itemId))
        .run();
    else if (reason === "deleted")
      e.db
        .update(lectures)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(lectures.id, e.lectureId))
        .run();
    else if (reason === "archived-course")
      e.db
        .update(courses)
        .set({ archivedAt: new Date().toISOString() })
        .where(eq(courses.id, e.b.id))
        .run();
    else
      e.db
        .delete(courseStudents)
        .where(eq(courseStudents.courseId, e.b.id))
        .run();
    e.db
      .update(lectures)
      .set({
        markdown:
          '# 隐藏的新顺序\n\n::::question{id="q1" type="fill"}\n第一题 [[隐藏正文]]\n::::',
      })
      .where(eq(lectures.id, e.lectureId))
      .run();
    const denied = await e.resolve({ ...e.target, surface: "lesson" });
    expect(denied.status).toBe(404);
    assertNoLeak(await denied.json());
    expect(
      (
        await e.resolve({
          ...e.target,
          surface: "lesson",
          expectedQuestionRevisionId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    const attempt = await e.resolve();
    expect(attempt.status).toBe(200);
    const draft = learningContextOkSchema.parse(await attempt.json()).data;
    expect(draft.session).toMatchObject({
      questionNo: 2,
      questionCount: 2,
      questionRevisionId: e.rowIds[1],
    });
    e.db
      .update(attempts)
      .set({ status: "submitted", submittedAt: new Date().toISOString() })
      .where(eq(attempts.id, e.attemptId))
      .run();
    const result = await e.resolve({ ...e.target, surface: "result" });
    expect(result.status).toBe(200);
    expect(
      learningContextOkSchema.parse(await result.json()).data.session,
    ).toMatchObject({
      questionNo: 2,
      questionCount: 2,
      questionRevisionId: e.rowIds[1],
    });
    expect((await e.resolve({ ...e.target, surface: "lesson" })).status).toBe(
      404,
    );
  },
);

it("带真实device头允许已有auth/session/device簿记，不改学习业务表", async () => {
  const e = setup();
  expect((await e.resolve()).status).toBe(200);
  const before = {
    attempt: e.db.select().from(attempts).all(),
    responses: e.db.select().from(responses).all(),
  };
  expect(e.db.select().from(devices).all()).toHaveLength(0);
  const deviceId = randomUUID();
  const response = await e.resolve(e.target, {
    [DEVICE_ID_HEADER]: deviceId,
    [DEVICE_INFO_HEADER]: JSON.stringify({
      deviceId,
      type: "desktop",
      os: "Linux",
      browser: "Chromium",
      standalone: false,
    }),
  });
  expect(response.status).toBe(200);
  expect(e.db.select().from(devices).all()).toHaveLength(1);
  expect({
    attempt: e.db.select().from(attempts).all(),
    responses: e.db.select().from(responses).all(),
  }).toEqual(before);
});

it("opaque冻结行引用可作为expected；错版仍409，跨账号仍404", async () => {
  const e = setup();
  const rowId = "legacy-row-opaque";
  e.db
    .update(responses)
    .set({ id: rowId })
    .where(eq(responses.id, e.rowIds[1] ?? ""))
    .run();
  const target = { ...e.target, expectedQuestionRevisionId: rowId };
  const r = await e.resolve(target);
  expect(r.status).toBe(200);
  expect(
    learningContextOkSchema.parse(await r.json()).data.session
      ?.questionRevisionId,
  ).toBe(rowId);
  const wrong = await e.resolve({
    ...target,
    expectedQuestionRevisionId: "legacy-other-row",
  });
  expect(wrong.status).toBe(409);
  assertNoLeak(await wrong.json());
  const other = makeStudent(e.db);
  const denied = await e.resolve(target, {
    cookie: `tutor_student_session=${createStudentSession(e.db, other).token}`,
  });
  expect(denied.status).toBe(404);
  assertNoLeak(await denied.json());
  expect(
    (await e.resolve({ ...target, attemptId: "opaque-attempt" })).status,
  ).toBe(400);
});
