import { expect, it } from "vitest";
import { createTestDb } from "../db/test-utils.ts";
import { newDraftAttempt } from "./attempt-service.ts";
import {
  createQuestionReviewReader,
  questionReviewReadable,
} from "./review-access.ts";

const attempt = () =>
  newDraftAttempt({
    id: "attempt",
    studentId: "student",
    sourceType: "course",
    assignmentId: null,
    courseId: "removed-course",
    unitId: "removed-unit",
    attemptNo: 1,
    startedAt: "2026-10-24T00:00:00.000Z",
    practiceWorkflowVersion: 1,
    feedbackMode: "per_question",
    workflowRevision: 0,
  });

it("进行中卷失去课程可见性后，错题与历史读侧不能借单题提交绕过守卫", () => {
  const db = createTestDb();
  expect(
    questionReviewReadable(
      db,
      attempt(),
      { submittedAt: "2026-10-24T00:01:00.000Z" },
      new Date(),
    ),
  ).toBe(false);
  db.$client.close();
});
it("作废卷不可读；同卷未交题不能因已交题授权缓存而变得可读", () => {
  const db = createTestDb();
  const lesson = {
    ...attempt(),
    sourceType: "lesson" as const,
    courseId: null,
    unitId: null,
    lectureId: "lecture",
  };
  const readable = createQuestionReviewReader(db, new Date());
  expect(readable(lesson, { submittedAt: "2026-10-24T00:01:00.000Z" })).toBe(
    true,
  );
  expect(readable(lesson, { submittedAt: null })).toBe(false);
  expect(
    questionReviewReadable(
      db,
      { ...lesson, abandonedAt: "2026-10-24T00:02:00.000Z" },
      { submittedAt: "2026-10-24T00:01:00.000Z" },
      new Date(),
    ),
  ).toBe(false);
  db.$client.close();
});
