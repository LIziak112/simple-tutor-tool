import {
  type LessonQuestionSubmitRequest,
  lessonQuestionSubmitDataSchema,
} from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { requireOwnAttempt } from "./attempt-access.ts";
import {
  attemptSummaryOf,
  lessonLiveSummaryOf,
  materialSlotOrderOf,
  resultQuestionOf,
  studentFacingResultOf,
  submitLessonQuestion,
} from "./attempt-service.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { submitQuestionDelivery } from "./kernel-question-delivery.ts";
import { lessonKernelBinding } from "./kernel-question-delivery-binding.ts";
import { snapshotOfRow } from "./snapshot.ts";

export function submitBoundLessonQuestion(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  input: LessonQuestionSubmitRequest,
) {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  if (attempt.sourceType !== "lesson" || !lessonKernelBinding(db, attempt.id))
    return submitLessonQuestion(db, studentId, attemptId, questionId, input);
  const { evidence, ...revision } = input;
  const projection = submitQuestionDelivery(
    db,
    dataDir,
    studentId,
    attemptId,
    "question",
    {
      revisions: [{ ...revision, questionId }],
      ...(evidence && { evidence: [evidence] }),
    },
    new Date(),
  );
  if (projection?.error) throw projection.error;
  const facts = projection?.facts;
  const row = facts?.rows.find((item) => item.questionId === questionId);
  const snapshot = row && snapshotOfRow(row);
  if (!facts || !row || !snapshot) kernelAttemptUnavailable();
  return lessonQuestionSubmitDataSchema.parse({
    question: studentFacingResultOf(
      resultQuestionOf(row, snapshot, {
        db,
        materialSlots: materialSlotOrderOf(db, attemptId),
      }),
    ),
    summary: lessonLiveSummaryOf(
      facts.rows.map((item) => ({
        ...item,
        hasSnapshot: item.questionSnapshotJson !== null,
      })),
      facts.attempt,
    ),
    attempt: attemptSummaryOf(facts.attempt),
  });
}
