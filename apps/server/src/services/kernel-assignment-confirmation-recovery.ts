import { assignmentScoringSourcesSchema } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { requireOwnAttempt } from "./attempt-access.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  assertConfirmationBinding,
  type KernelConfirmationTicket,
} from "./kernel-assignment-confirmation-ticket.ts";
import { projectKernelConfirmationFacts } from "./kernel-assignment-confirmed-detail.ts";
import {
  type KernelAttemptBinding,
  type KernelRuntime,
  kernelAttemptUnavailable,
  recoverEvaluated,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import { projectConfirmedChoiceVerdicts } from "./kernel-choice-verdicts.ts";
import type { DeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import type { MarkIntent } from "./kernel-verdict-target.ts";
import { snapshotOfRow } from "./snapshot.ts";

type ConfirmationScope = ReturnType<typeof confirmationScopeOf>;

export interface RecoveryRequest {
  studentId: string;
  activityId: string;
  stepAttemptId: string;
  operationId: string;
}

export function confirmationScopeOf(
  attempt: Attempt,
  ticket: KernelConfirmationTicket,
) {
  if (attempt.assignmentId === null || ticket.attemptId !== attempt.id)
    kernelAttemptUnavailable();
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    assignmentId: attempt.assignmentId,
    operationId: ticket.operationId,
    stepAttemptId: ticket.stepAttemptId,
    practiceVersion: ticket.practiceVersion,
    slotId: "answers",
    questionRevisions: new Map(
      ticket.request.revisions.map(({ questionId, questionRevisionId }) => [
        questionId,
        questionRevisionId,
      ]),
    ),
  };
}

export function permitsRecovery(
  scope: ConfirmationScope,
  request: RecoveryRequest,
) {
  return (
    request.studentId === scope.studentId &&
    request.activityId === scope.attemptId &&
    request.stepAttemptId === scope.stepAttemptId &&
    request.operationId === scope.operationId
  );
}

export function recoverKernelConfirmation(
  db: Db,
  runtime: KernelRuntime,
  scope: ConfirmationScope,
  review?: { dataDir: string; intent: MarkIntent | undefined },
): DeliveryFacts {
  return db.$client
    .transaction(() => {
      const attempt = requireOwnAttempt(db, scope.studentId, scope.attemptId);
      if (
        attempt.assignmentId !== scope.assignmentId ||
        attempt.abandonedAt !== null
      )
        kernelAttemptUnavailable();
      const rows = attemptResponseRows(db, attempt.id);
      const scoring = assignmentScoringSourcesSchema.safeParse(
        rows.map(snapshotOfRow),
      );
      if (!scoring.success) kernelAttemptUnavailable();
      const recover =
        scoring.data.slotType === "oneResponsePerQuestion"
          ? runtime.recoverResponseConfirmation
          : runtime.recoverChoiceConfirmation;
      const recovered = recoverEvaluated(
        runtime,
        () =>
          recover({ role: "student", id: attempt.studentId }, attempt.id, {
            protocolVersion: 1,
            stepAttemptId: scope.stepAttemptId,
            operationId: scope.operationId,
          }),
        (result) => result.evaluation?.status,
      );
      const projected = projectKernelDraftActivity(db, attempt, runtime);
      const facts = projectKernelConfirmationFacts(
        db,
        projected,
        scope,
        rows,
        recovered,
      );
      if (review && recovered.confirmation.kind === "choiceConfirmation")
        return projectConfirmedChoiceVerdicts(
          db,
          review.dataDir,
          facts,
          scope,
          recovered.receipt,
          review.intent,
        );
      if (review?.intent) kernelAttemptUnavailable();
      return facts;
    })
    .immediate();
}

export type RecoverKernelConfirmation = (
  attempt: Attempt,
  binding: KernelAttemptBinding,
  ticket: KernelConfirmationTicket,
) => ReturnType<typeof recoverKernelConfirmation>;

/** 一次连接读取已核验归属的作答，恢复权限始终限于当前卷的持久确认操作。 */
export function withKernelConfirmationReader<T>(
  db: Db,
  dataDir: string,
  read: (runtime: KernelRuntime, recover: RecoverKernelConfirmation) => T,
): T {
  let scope: ConfirmationScope | undefined;
  return withKernelRuntime(
    db,
    dataDir,
    false,
    (runtime) =>
      read(runtime, (attempt, binding, ticket) => {
        const selected = confirmationScopeOf(attempt, ticket);
        assertConfirmationBinding(selected, binding);
        scope = selected;
        try {
          return recoverKernelConfirmation(db, runtime, selected, {
            dataDir,
            intent: undefined,
          });
        } finally {
          scope = undefined;
        }
      }),
    {
      evaluateScope: () => scope,
      authorizeConfirmationRecovery: (request) =>
        scope !== undefined && permitsRecovery(scope, request),
    },
  );
}
