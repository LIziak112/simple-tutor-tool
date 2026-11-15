import {
  type StudentMcpPracticeQuestionData,
  studentMcpPracticeSubmitParametersSchema,
} from "@tutor/contract";
import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertAttemptNotTimedOut } from "./attempt-timing.ts";
import { getStudentNoteHead } from "./note-service.ts";
import {
  attemptWorkflowView,
  practiceProtocolOf,
} from "./practice-workflow-wiring.ts";

type Availability = StudentMcpPracticeQuestionData["submission"];

/**
 * 调用方已经过本人、当前AI与冻结题目门；这里只读准备，不授权或执行提交。
 * 笔记公开头为revision，不是数据库列名currentRevision；本地未上传稿仍须本人确认。
 */
export function studentMcpSubmissionParameters(
  db: Db,
  studentId: string,
  attempt: Attempt,
  row: Pick<ResponseRow, "id" | "questionId" | "submittedAt">,
  expectedAnswerRevision: number | undefined,
  now: Date | string = new Date(),
  purpose: "question" | "settlement" = "question",
): Availability {
  if (attempt.status !== "draft" || row.submittedAt !== null) {
    return { available: false, reason: "QUESTION_ALREADY_SUBMITTED" };
  }
  const protocol = practiceProtocolOf(attempt);
  if (protocol === "lesson")
    return { available: false, reason: "WORKFLOW_PROTOCOL_MISMATCH" };
  if (protocol === "legacy")
    return { available: false, reason: "WORKFLOW_LEGACY" };
  const workflow = attemptWorkflowView(db, attempt, now)?.practiceWorkflow;
  if (workflow === undefined)
    return { available: false, reason: "WORKFLOW_LEGACY" };
  if (
    !(purpose === "settlement"
      ? workflow.canSettlePartially
      : workflow.canSubmitQuestion)
  )
    return { available: false, reason: "WORKFLOW_RESTRICTED" };
  try {
    assertAttemptNotTimedOut(attempt, now, "running");
  } catch (error) {
    if (error instanceof HttpError && error.code === "ATTEMPT_TIME_UP") {
      return { available: false, reason: "ATTEMPT_TIME_UP" };
    }
    throw error;
  }
  if (expectedAnswerRevision === undefined)
    return { available: false, reason: "SUBMISSION_VERSION_UNAVAILABLE" };

  const { note } = getStudentNoteHead(
    db,
    studentId,
    attempt.id,
    row.questionId,
  );
  const evidence =
    note === null || note.revision === 0
      ? { questionId: row.questionId, state: "none" as const }
      : {
          questionId: row.questionId,
          state: "frozen" as const,
          versionId: note.currentVersionId,
          revision: note.revision,
        };
  return {
    available: true,
    parameters: studentMcpPracticeSubmitParametersSchema.parse({
      practiceId: attempt.id,
      questionId: row.questionId,
      workflowVersion: workflow.version,
      workflowRevision: workflow.revision,
      questionRevisionId: row.id,
      expectedAnswerRevision,
      evidence,
    }),
  };
}
