import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTextMemo } from "../services/memo-service.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { backfillMemoMetadata } from "./backfill-memo-metadata.ts";
import {
  attempts,
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  memos,
  units,
} from "./schema.ts";
import {
  createTestDb,
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "./test-utils.ts";

describe("随笔元数据历史回填", () => {
  it("本人按创建时间与id编号，包含软删；无可靠设备不猜；重跑不改变编号", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const old = ["2026-01-02", "2026-01-01", "2026-01-01"].map((at) => {
      const memo = createTextMemo(db, {
        studentId,
        clientId: randomUUID(),
        text: "旧条目",
      }).memo;
      db.update(memos)
        .set({ seq: null, createdAt: new Date(at).toISOString() })
        .where(eq(memos.id, memo.id))
        .run();
      return memo.id;
    });
    db.update(memos)
      .set({ deletedAt: "2026-01-03T00:00:00.000Z" })
      .where(eq(memos.id, old[0] ?? ""))
      .run();
    const otherId = makeStudent(db);
    const other = createTextMemo(db, {
      studentId: otherId,
      clientId: randomUUID(),
      text: "另一人",
    }).memo;
    db.update(memos).set({ seq: null }).where(eq(memos.id, other.id)).run();
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "session_context_memo_metadata_v1"))
      .run();
    backfillMemoMetadata(db);
    const rows = db.select().from(memos).all();
    const ordered = rows
      .filter((r) => r.studentId === studentId)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    expect(ordered.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.id === other.id)?.seq).toBe(1);
    expect(
      rows.every((r) => r.deviceId === null && r.contextJson === null),
    ).toBe(true);
    backfillMemoMetadata(db);
    expect(db.select().from(memos).all()).toEqual(rows);
    expect(
      createTextMemo(db, { studentId, clientId: randomUUID(), text: "新条目" })
        .memo.seq,
    ).toBe(4);
  });
  it("已有题目锚恢复responses版本及题序，拒绝引用他人的上下文", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const { attemptId, rowIds } = frozenDraftAttempt(db, studentId, [
      { questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }) },
      { questionId: "q2", snapshotJson: snapshotJsonOf({ id: "q2" }) },
    ]);
    const memo = createTextMemo(db, {
      studentId,
      clientId: randomUUID(),
      text: "第2题",
      anchor: { kind: "question", attemptId, questionId: "q2", label: "旧题" },
    }).memo;
    expect(memo.context?.session).toMatchObject({
      attemptId,
      questionRevisionId: rowIds[1],
      questionNo: 2,
      questionCount: 2,
    });
    const context = memo.context;
    if (context == null || context.session === null)
      throw new Error("缺少上下文");
    const session = context.session;
    const explicit = createTextMemo(db, {
      studentId,
      clientId: randomUUID(),
      text: "仅上下文",
      context,
    }).memo;
    expect(explicit.anchor).toMatchObject({
      kind: "question",
      attemptId,
      questionId: "q2",
    });
    expect(() =>
      createTextMemo(db, {
        studentId,
        clientId: randomUUID(),
        text: "错版",
        context: {
          ...context,
          session: { ...session, questionRevisionId: randomUUID() },
        },
      }),
    ).toThrow();
    expect(() =>
      createTextMemo(db, {
        studentId: makeStudent(db),
        clientId: randomUUID(),
        text: "伪造",
        context,
      }),
    ).toThrow();
    db.update(memos)
      .set({ seq: null, contextJson: null })
      .where(eq(memos.id, memo.id))
      .run();
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "session_context_memo_metadata_v1"))
      .run();
    backfillMemoMetadata(db);
    expect(
      JSON.parse(
        db.select().from(memos).where(eq(memos.id, memo.id)).get()
          ?.contextJson ?? "null",
      ).session.questionRevisionId,
    ).toBe(rowIds[1]);
  });
});

it("新保存按当前草稿权限补元数据，历史回填保留本人既有冻结坐标且不重新冻结", () => {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const { unitId } = seedLessonWithEmbeddedUnit(db);
  db.update(units).set({ lectureId: null }).where(eq(units.id, unitId)).run();
  const courseId = randomUUID();
  const now = "2026-11-01T00:00:00.000Z";
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "旧课程",
      order: 0,
      createdAt: now,
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: now })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "unit",
      refId: unitId,
      order: 0,
      visible: true,
      createdAt: now,
    })
    .run();
  const { attemptId, rowIds } = frozenDraftAttempt(
    db,
    studentId,
    [{ questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }), unitId }],
    { attemptUnitId: unitId },
  );
  db.update(attempts)
    .set({ sourceType: "course", courseId })
    .where(eq(attempts.id, attemptId))
    .run();
  const anchor = {
    kind: "question" as const,
    attemptId,
    questionId: "q1",
    label: "旧题目锚",
  };
  const prior = createTextMemo(db, {
    studentId,
    clientId: randomUUID(),
    text: "已保存的旧条目",
    anchor,
  }).memo;
  const before = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  db.delete(courseStudents).where(eq(courseStudents.courseId, courseId)).run();
  const current = createTextMemo(db, {
    studentId,
    clientId: randomUUID(),
    text: "失权后的旧格式条目",
    anchor,
  }).memo;
  expect(current.context).toBeNull();
  db.update(memos)
    .set({ contextJson: null })
    .where(eq(memos.id, prior.id))
    .run();
  db.delete(dataMigrations)
    .where(eq(dataMigrations.key, "session_context_memo_metadata_v1"))
    .run();
  backfillMemoMetadata(db);
  const historical = JSON.parse(
    db.select().from(memos).where(eq(memos.id, prior.id)).get()?.contextJson ??
      "null",
  );
  expect(historical.session).toMatchObject({
    attemptId,
    questionRevisionId: rowIds[0],
  });
  expect(historical.content).toMatchObject({
    courseId,
    unitId,
    lectureId: null,
  });
  expect(
    db.select().from(attempts).where(eq(attempts.id, attemptId)).get(),
  ).toEqual(before);
});
