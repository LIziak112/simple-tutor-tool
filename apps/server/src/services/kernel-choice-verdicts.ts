import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { requireAssignmentRow } from "./attempt-access.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { projectKernelVerdicts } from "./kernel-delivery-verdicts.ts";
import type { MarkIntent } from "./kernel-verdict-target.ts";

export function projectConfirmedChoiceVerdicts(
  db: Db,
  dataDir: string,
  facts: { attempt: Attempt; rows: ResponseRow[] },
  scope: {
    assignmentId: string;
    operationId: string;
    stepAttemptId: string;
    practiceVersion: number;
    slotId: string;
  },
  receipt: { id: string; stepAttemptId: string; slotId: string },
  intent?: MarkIntent,
) {
  if (
    facts.attempt.sourceType !== "assignment" ||
    facts.attempt.assignmentId !== scope.assignmentId ||
    receipt.stepAttemptId !== scope.stepAttemptId ||
    receipt.slotId !== scope.slotId
  )
    kernelAttemptUnavailable();
  const { teacherId } = requireAssignmentRow(db, scope.assignmentId);
  if (!teacherId) kernelAttemptUnavailable();
  return projectKernelVerdicts(
    db,
    dataDir,
    facts,
    scope.assignmentId,
    [
      {
        mode: "choiceConfirmation",
        operationId: scope.operationId,
        stepAttemptId: scope.stepAttemptId,
        practiceVersion: scope.practiceVersion,
        slotId: scope.slotId,
        receiptId: receipt.id,
        originalTeacherId: teacherId,
        questionIds: facts.rows.map(({ questionId }) => questionId),
      },
    ],
    intent,
  );
}
