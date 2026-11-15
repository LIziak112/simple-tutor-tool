import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  attempts,
  courseItems,
  courseStudents,
  courses,
  questions,
  units,
} from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { createTextMemo } from "../services/memo-service";
import { frozenDraftAttempt, snapshotJsonOf } from "./evidence-fixtures";
import { makeStudent } from "./note-fixtures";
/** 多单元作业的单元坐标属于冻结response，卷级unitId为空。 */
export function memoSourceFixture() {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const otherId = makeStudent(db);
  const courseId = randomUUID();
  const otherCourseId = randomUUID();
  const unitId = "memo-source-unit";
  const otherUnitId = "other-unit";
  const now = "2026-01-01T00:00:00.000Z";
  for (const id of [courseId, otherCourseId]) {
    db.insert(courses)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        title: "来源课程",
        order: 0,
        createdAt: now,
      })
      .run();
    db.insert(courseStudents)
      .values({ courseId: id, studentId, joinedAt: now })
      .run();
  }
  for (const id of [unitId, otherUnitId])
    db.insert(units)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        title: "来源单元",
        order: 0,
        updatedAt: now,
      })
      .run();
  db.insert(questions)
    .values({
      id: "q1",
      teacherId: TEST_TEACHER_ID,
      unitId,
      order: 0,
      type: "fill",
      difficulty: 2,
      stemMd: "题干",
      hintsJson: "[]",
      sourceMd: "SECRET_SOURCE_SENTINEL",
      answersJson: '{"secret":"SECRET_ANSWER_SENTINEL"}',
      solutionMd: "SECRET_SOLUTION_SENTINEL",
      updatedAt: now,
    })
    .run();
  const itemId = randomUUID();
  db.insert(courseItems)
    .values({
      id: itemId,
      courseId,
      kind: "unit",
      refId: unitId,
      order: 0,
      visible: true,
      createdAt: now,
    })
    .run();
  const makeAttempt = (owner = studentId, course = courseId, unit = unitId) => {
    const { attemptId } = frozenDraftAttempt(db, owner, [
      {
        questionId: "q1",
        unitId: unit,
        snapshotJson: snapshotJsonOf({
          id: "q1",
          solutionMd: "SECRET_SOLUTION_SENTINEL",
        }),
      },
    ]);
    db.update(attempts)
      .set({ courseId: course, unitId: null })
      .where(eq(attempts.id, attemptId))
      .run();
    return attemptId;
  };
  const original = makeAttempt();
  const memo = createTextMemo(db, {
    studentId,
    clientId: randomUUID(),
    text: "来源随笔",
    anchor: {
      kind: "question",
      attemptId: original,
      questionId: "q1",
      label: "本人来源",
    },
  }).memo;
  db.update(attempts)
    .set({ abandonedAt: now })
    .where(eq(attempts.id, original))
    .run();
  return {
    db,
    studentId,
    otherId,
    courseId,
    otherCourseId,
    unitId,
    otherUnitId,
    itemId,
    original,
    memo,
    makeAttempt,
  };
}
