import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { assignmentReleaseByIds } from "./attempt-service.ts";
import {
  attemptAnswersPublished,
  resolvePracticeQuestionFeedbackState,
} from "./practice-workflow-service.ts";
import {
  assertDraftCourseVisible,
  attemptWorkflowView,
} from "./practice-workflow-wiring.ts";

/** 复用已有题级/整卷公布裁决，不将 AI 出口授权当成学生读答案权限。 */
export function questionReviewReadable(
  db: Db,
  attempt: Attempt,
  row: Pick<ResponseRow, "submittedAt">,
  now: Date | string,
): boolean {
  if (attempt.abandonedAt !== null) return false;
  if (attempt.status !== "draft") {
    const release =
      attempt.sourceType === "assignment"
        ? (assignmentReleaseByIds(db, [attempt.assignmentId ?? ""]).get(
            attempt.assignmentId ?? "",
          ) ?? null)
        : null;
    return attemptAnswersPublished(
      { attemptSubmitted: true, sourceType: attempt.sourceType, release },
      now,
    );
  }
  if (row.submittedAt === null) return false;
  if (attempt.sourceType === "lesson") return true;
  try {
    assertDraftCourseVisible(db, attempt.studentId, attempt);
  } catch (error) {
    if (error instanceof HttpError && [403, 404, 409].includes(error.status))
      return false;
    throw error;
  }
  return (
    resolvePracticeQuestionFeedbackState({
      submitted: true,
      attemptSubmitted: false,
      published: false,
      workflow: attemptWorkflowView(db, attempt, now)?.practiceWorkflow ?? null,
    }).status === "released"
  );
}

/** 同一次列表装配按卷复用当前授权，避免每题反复读取整卷工作流。 */
export function createQuestionReviewReader(db: Db, now: Date | string) {
  const byAttempt = new Map<string, boolean>();
  return (attempt: Attempt, row: Pick<ResponseRow, "submittedAt">): boolean => {
    if (attempt.status === "draft" && row.submittedAt === null) return false;
    const cached = byAttempt.get(attempt.id);
    if (cached !== undefined) return cached;
    const readable = questionReviewReadable(db, attempt, row, now);
    byAttempt.set(attempt.id, readable);
    return readable;
  };
}
