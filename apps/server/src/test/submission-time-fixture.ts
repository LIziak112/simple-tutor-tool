import { randomUUID } from "node:crypto";
import type {
  PracticeQuestionSubmitWithAnswer,
  Question,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  attempts,
  events,
  type NewEventRow,
  responses,
  students,
} from "../db/schema.ts";
import {
  createTestDb,
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { insertFrozenResponse } from "../services/attempt-freeze.ts";
import {
  submitLessonQuestion,
  submitPracticeQuestion,
} from "../services/attempt-question-submit.ts";
import { newDraftAttempt } from "../services/new-draft-attempt.ts";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const open: Db[] = [];
export function closeTimingFixtures() {
  for (const db of open.splice(0)) db.$client.close();
}

export function timingFixture(source: "wrong" | "lesson" = "wrong") {
  const db = createTestDb();
  open.push(db);
  const studentId = randomUUID(),
    attemptId = randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "计时学生",
      loginName: studentId,
      linkToken: studentId,
      createdAt: at(0),
    })
    .run();
  const lesson = source === "lesson" ? seedLessonWithEmbeddedUnit(db) : null;
  db.insert(attempts)
    .values(
      newDraftAttempt({
        id: attemptId,
        studentId,
        ...(lesson
          ? {
              sourceType: "lesson" as const,
              lectureId: lesson.lectureId,
              unitId: lesson.unitId,
            }
          : { sourceType: "wrong" as const, lectureId: null, unitId: null }),
        assignmentId: null,
        courseId: null,
        attemptNo: 1,
        startedAt: at(0),
        ...(source === "wrong"
          ? {
              practiceWorkflowVersion: 1 as const,
              feedbackMode: "per_question" as const,
            }
          : {}),
      }),
    )
    .run();
  for (const questionId of ["q1", "q2"]) {
    const snapshot: Question = {
      id: questionId,
      type: "judge",
      difficulty: 1,
      knowledge: [],
      stemMd: "判断题",
      sourceMd: "",
      hints: [],
      answers: { kind: "judge", value: true },
    };
    db.transaction((tx) =>
      insertFrozenResponse(tx, {
        attemptId,
        questionId,
        questionVersion: 1,
        questionSnapshotJson: JSON.stringify(snapshot),
        unitId: lesson?.unitId ?? null,
      }),
    );
  }
  const row = (questionId: string) => {
    const found = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all()
      .find((r) => r.questionId === questionId);
    if (!found) throw new Error("测试题目缺失");
    return found;
  };
  const event = (
    type: NewEventRow["type"],
    sec: number,
    questionId: string | null = null,
  ) =>
    db
      .insert(events)
      .values({
        id: randomUUID(),
        attemptId,
        studentId,
        questionId,
        type,
        clientTs: 1_000_000 + sec * 1000,
        serverTs: at(sec),
        payloadJson: JSON.stringify({
          type,
          questionId,
          viewId: "timing-view",
        }),
      })
      .run();
  const practiceRequest = (
    questionId: string,
  ): PracticeQuestionSubmitWithAnswer => ({
    workflowVersion: 1,
    workflowRevision: 0,
    questionRevisionId: row(questionId).id,
    expectedAnswerRevision: 0,
    submissionMutationId: randomUUID(),
    evidence: { questionId, state: "none" },
  });
  const submit = (questionId: string, sec: number) =>
    source === "lesson"
      ? submitLessonQuestion(
          db,
          studentId,
          attemptId,
          questionId,
          { questionRevisionId: row(questionId).id, expectedAnswerRevision: 0 },
          at(sec),
        )
      : submitPracticeQuestion(
          db,
          studentId,
          attemptId,
          questionId,
          practiceRequest(questionId),
          at(sec),
        );
  return { db, studentId, attemptId, row, event, submit, practiceRequest };
}
