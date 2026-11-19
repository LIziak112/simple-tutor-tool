import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import type { kernelAttemptConfirmations } from "../db/schema-kernel-assignments.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import { projectKernelChoiceFacts } from "./kernel-assignment-confirmed-detail.ts";
import {
  type KernelAttemptBinding,
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";

export type KernelConfirmationTicket =
  typeof kernelAttemptConfirmations.$inferSelect;

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

export function assertConfirmationBinding(
  scope: ConfirmationScope,
  binding: Pick<KernelAttemptBinding, "stepAttemptId" | "practiceVersion">,
) {
  if (
    scope.stepAttemptId !== binding.stepAttemptId ||
    scope.practiceVersion !== binding.practiceVersion
  )
    kernelAttemptUnavailable();
}

export function recoverKernelConfirmation(
  db: Db,
  attempt: Attempt,
  runtime: KernelRuntime,
  scope: ConfirmationScope,
) {
  const recovered = runtime.recoverChoiceConfirmation(
    { role: "student", id: attempt.studentId },
    attempt.id,
    {
      protocolVersion: 1,
      stepAttemptId: scope.stepAttemptId,
      operationId: scope.operationId,
    },
  );
  const projected = projectKernelDraftActivity(db, attempt, runtime);
  return projectKernelChoiceFacts(db, projected, scope, recovered);
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
          return recoverKernelConfirmation(db, attempt, runtime, selected);
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
