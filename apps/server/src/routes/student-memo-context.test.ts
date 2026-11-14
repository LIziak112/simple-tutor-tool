import { randomUUID } from "node:crypto";
import {
  type LearningContext,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoListDataSchema,
  memoSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import {
  backfillMemoMetadata,
  MEMO_METADATA_BACKFILL_KEY,
} from "../db/backfill-memo-metadata.ts";
import {
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  lectures,
  memos,
  teachers,
  units,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { requireVisibleStudentLecture } from "../services/student-course-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeNotePng, makeStudent } from "../test/note-fixtures.ts";

const PRIVATE_TITLE = "REVIEW_PRIVATE_LECTURE_CANARY";
type Visibility =
  | "unlisted"
  | "hidden"
  | "future"
  | "deleted"
  | "foreign"
  | "visible";

function setup(visibility: Visibility = "visible") {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { lectureId, unitId } = seedLessonWithEmbeddedUnit(db, {
    lectureTitle: PRIVATE_TITLE,
    unitTitle: "公开单元",
  });
  db.update(lectures)
    .set({ kind: "lecture" })
    .where(eq(lectures.id, lectureId))
    .run();
  const courseId = randomUUID();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "公开课程",
      order: 0,
      createdAt: new Date().toISOString(),
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: new Date().toISOString() })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "unit",
      refId: unitId,
      title: null,
      order: 0,
      visible: true,
      createdAt: new Date().toISOString(),
    })
    .run();
  const lectureItemId = randomUUID();
  if (visibility !== "unlisted")
    db.insert(courseItems)
      .values({
        id: lectureItemId,
        courseId,
        kind: "lecture",
        refId: lectureId,
        title: null,
        order: 1,
        visible: visibility !== "hidden",
        publishAt: visibility === "future" ? "2099-01-01T00:00:00.000Z" : null,
        createdAt: new Date().toISOString(),
      })
      .run();
  if (visibility === "deleted")
    db.update(lectures)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(lectures.id, lectureId))
      .run();
  if (visibility === "foreign") {
    const teacherId = randomUUID();
    db.insert(teachers)
      .values({
        id: teacherId,
        loginName: teacherId,
        isAdmin: false,
        createdAt: new Date().toISOString(),
      })
      .run();
    db.update(lectures)
      .set({ teacherId })
      .where(eq(lectures.id, lectureId))
      .run();
  }
  const { attemptId, rowIds } = frozenDraftAttempt(
    db,
    studentId,
    [{ questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }), unitId }],
    { attemptUnitId: unitId },
  );
  const revision = rowIds[0];
  if (revision === undefined) throw new Error("缺少冻结题目");
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    logger: pino({ enabled: false }),
    isProduction: false,
  });
  const headers = {
    cookie: `tutor_student_session=${createStudentSession(db, studentId).token}`,
    [MEMO_OUTBOX_ACCOUNT_HEADER]: studentId,
  };
  const anchor = {
    kind: "question" as const,
    attemptId,
    questionId: "q1",
    label: "本人可见题",
  };
  const post = async (body: object) =>
    app.request("/api/student/memos", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: randomUUID(),
        text: "本人记录",
        ...body,
      }),
    });
  const media = async (source: object) => {
    const form = new FormData();
    form.set("clientId", randomUUID());
    form.set("kind", "image");
    for (const [key, value] of Object.entries(source))
      form.set(key, JSON.stringify(value));
    form.set(
      "file",
      new Blob([new Uint8Array(makeNotePng()).buffer]),
      "memo.png",
    );
    return app.request("/api/student/memos/media", {
      method: "POST",
      headers,
      body: form,
    });
  };
  const list = async (id = attemptId) => {
    const response = await app.request(`/api/student/memos?attemptId=${id}`, {
      headers,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    assertNoLeak(body);
    return memoListDataSchema.parse(body.data);
  };
  return {
    db,
    app,
    studentId,
    lectureId,
    lectureItemId,
    unitId,
    courseId,
    attemptId,
    revision,
    headers,
    anchor,
    post,
    media,
    list,
  };
}

async function readCreated(response: Response) {
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: unknown };
  assertNoLeak(body);
  return memoSchema.parse(body.data);
}

describe("随笔上下文来源的可见性与兼容边界", () => {
  it.each<Visibility>(["unlisted", "hidden", "future", "deleted", "foreign"])(
    "%s讲义不经题目随笔、媒体、列表或历史回填泄露",
    async (visibility) => {
      const env = setup(visibility);
      expect(() =>
        requireVisibleStudentLecture(env.db, env.studentId, env.lectureId),
      ).toThrow();
      for (const response of [
        await env.post({ anchor: env.anchor }),
        await env.media({ anchor: env.anchor }),
      ]) {
        const memo = await readCreated(response);
        expect(memo.context?.content).toMatchObject({
          lectureId: null,
          titles: { lecture: null },
        });
        expect(JSON.stringify(memo)).not.toContain(env.lectureId);
        expect(JSON.stringify(memo)).not.toContain(PRIVATE_TITLE);
      }
      const before = await env.list();
      expect(before.memos).toHaveLength(2);
      for (const memo of before.memos)
        env.db
          .update(memos)
          .set({ contextJson: null })
          .where(eq(memos.id, memo.id))
          .run();
      env.db
        .delete(dataMigrations)
        .where(eq(dataMigrations.key, MEMO_METADATA_BACKFILL_KEY))
        .run();
      backfillMemoMetadata(env.db);
      const after = await env.list();
      expect(
        after.memos.every(
          (memo) =>
            memo.context?.content.lectureId === null &&
            memo.context.content.titles.lecture === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(after)).not.toContain(env.lectureId);
      expect(JSON.stringify(after)).not.toContain(PRIVATE_TITLE);
      const context = after.memos[0]?.context;
      if (context == null) throw new Error("缺少公开题目上下文");
      const forged = {
        ...context,
        content: { ...context.content, lectureId: env.lectureId },
      };
      for (const response of [
        await env.post({ context: forged }),
        await env.media({ context: forged }),
      ]) {
        expect(response.status).toBe(404);
        const body = await response.json();
        assertNoLeak(body);
        expect(JSON.stringify(body)).not.toContain(env.lectureId);
        expect(JSON.stringify(body)).not.toContain(PRIVATE_TITLE);
      }
    },
  );

  it("真正可见的讲义保留来源；后来隐藏不会改写已保存的名称快照", async () => {
    const env = setup();
    const created = await readCreated(await env.post({ anchor: env.anchor }));
    expect(created.context?.content).toMatchObject({
      lectureId: env.lectureId,
      titles: { lecture: PRIVATE_TITLE },
    });
    await readCreated(await env.media({ anchor: env.anchor }));
    env.db
      .update(courseItems)
      .set({ visible: false })
      .where(eq(courseItems.id, env.lectureItemId))
      .run();
    expect(
      (await env.list()).memos.every(
        (memo) => memo.context?.content.titles.lecture === PRIVATE_TITLE,
      ),
    ).toBe(true);
  });

  it.each([80, 81, 160, 161])(
    "长度%i的题目id经新旧创建和列表往返保留锚与索引",
    async (length) => {
      const env = setup();
      const questionId = "q".repeat(length);
      const { attemptId, rowIds } = frozenDraftAttempt(env.db, env.studentId, [
        { questionId, snapshotJson: snapshotJsonOf({ id: questionId }) },
      ]);
      const revision = rowIds[0];
      if (revision === undefined) throw new Error("缺少版本");
      const context: LearningContext = {
        schemaVersion: 1,
        content: {
          courseId: null,
          unitId: null,
          lectureId: null,
          sectionId: null,
          questionId,
          titles: { course: null, unit: null, lecture: null },
        },
        session: {
          attemptId,
          questionRevisionId: revision,
          questionNo: 1,
          questionCount: 1,
          settlementSeq: null,
        },
        view: null,
        deviceId: null,
      };
      for (const source of [
        { context },
        {
          anchor: {
            kind: "question",
            attemptId,
            questionId,
            label: "旧题目锚",
          },
        },
      ]) {
        const memo = await readCreated(await env.post(source));
        expect(memo.anchor).toMatchObject({
          kind: "question",
          attemptId,
          questionId,
        });
        expect(memo.context?.content.questionId).toBe(questionId);
        expect(
          env.db.select().from(memos).where(eq(memos.id, memo.id)).get()
            ?.anchorAttemptId,
        ).toBe(attemptId);
      }
      const listed = await env.list(attemptId);
      expect(listed.memos).toHaveLength(2);
      expect(
        listed.memos.every(
          (memo) =>
            memo.anchor.kind === "question" &&
            memo.anchor.questionId === questionId,
        ),
      ).toBe(true);
    },
  );

  it.each([80, 81, 160, 161])(
    "长度%i的讲义小节id经新旧创建和列表往返保留",
    async (length) => {
      const env = setup();
      const sectionId = "s".repeat(length);
      const context: LearningContext = {
        schemaVersion: 1,
        content: {
          courseId: env.courseId,
          unitId: null,
          lectureId: env.lectureId,
          sectionId,
          questionId: null,
          titles: { course: "公开课程", unit: null, lecture: PRIVATE_TITLE },
        },
        session: null,
        view: null,
        deviceId: null,
      };
      for (const source of [
        { context },
        {
          anchor: {
            kind: "lecture",
            lectureId: env.lectureId,
            sectionId,
            label: "旧讲义锚",
          },
        },
      ]) {
        const memo = await readCreated(await env.post(source));
        expect(memo.anchor).toMatchObject({ kind: "lecture", sectionId });
        expect(memo.context?.content.sectionId).toBe(sectionId);
        expect(
          env.db.select().from(memos).where(eq(memos.id, memo.id)).get()
            ?.anchorLectureId,
        ).toBe(env.lectureId);
      }
      const response = await env.app.request(
        `/api/student/memos?lectureId=${env.lectureId}`,
        { headers: env.headers },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: unknown };
      assertNoLeak(body);
      const listed = memoListDataSchema.parse(body.data);
      expect(listed.memos).toHaveLength(2);
      expect(
        listed.memos.every(
          (memo) =>
            memo.anchor.kind === "lecture" &&
            memo.anchor.sectionId === sectionId,
        ),
      ).toBe(true);
    },
  );

  it.each(["unit", "lecture"] as const)(
    "合法501字符%s标题不会使旧格式随笔保存失败",
    async (kind) => {
      const env = setup();
      const title = "长".repeat(501);
      if (kind === "unit")
        env.db
          .update(units)
          .set({ title })
          .where(eq(units.id, env.unitId))
          .run();
      else
        env.db
          .update(lectures)
          .set({ title })
          .where(eq(lectures.id, env.lectureId))
          .run();
      const anchor =
        kind === "unit"
          ? env.anchor
          : {
              kind: "lecture",
              lectureId: env.lectureId,
              sectionId: null,
              label: "旧讲义锚",
            };
      const memo = await readCreated(await env.post({ anchor }));
      expect(memo.context?.content.titles[kind]).toBe(title);
    },
  );
});
