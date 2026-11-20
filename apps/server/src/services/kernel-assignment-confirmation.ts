import { randomUUID } from "node:crypto";
import {
  type AttemptSubmitRequest,
  attemptSubmissionConflictSchema,
  attemptSubmitRequestSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import {
  ChoiceConfirmationConflict,
  type ChoiceConfirmationInput,
  LearningError,
  type openLearningRuntime,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptConfirmations } from "../db/schema-kernel-assignments.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireOwnAttempt, requireUsableAttempt } from "./attempt-access.ts";
import { prepareChoiceOriginals } from "./attempt-choice-evidence.ts";
import { settleSubmissionOriginalReservation } from "./attempt-original-reservation.ts";
import { revisionStale } from "./attempt-submit-revisions.ts";
import { assertSavedAnswersConfirmed } from "./attempt-timing.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import {
  captureKernelConfirmationRequest,
  kernelActivitySealOf,
} from "./kernel-assignment-activity.ts";
import type { RecoveryRequest } from "./kernel-assignment-confirmation-recovery.ts";
import {
  confirmationScopeOf,
  permitsRecovery,
  recoverKernelConfirmation,
} from "./kernel-assignment-confirmation-recovery.ts";
import {
  assertConfirmationBinding,
  kernelConfirmationTicketFor,
  type KernelConfirmationTicket as Ticket,
} from "./kernel-assignment-confirmation-ticket.ts";
import { buildKernelChoiceResult } from "./kernel-assignment-confirmed-detail.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";
import {
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
  withBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";

import { recoverKernelChoiceAmendment } from "./kernel-choice-amendments.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
type OriginalQuestion = ChoiceConfirmationInput["questions"][number];

function alreadySubmitted(): never {
  throw new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");
}

function discardTicket(db: Db, ticket: Ticket): void {
  settleSubmissionOriginalReservation(db, ticket, "aborted");
  db.delete(kernelAttemptConfirmations)
    .where(eq(kernelAttemptConfirmations.attemptId, ticket.attemptId))
    .run();
}

function withTicket<T>(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  ticket: Ticket,
  operate: (
    runtime: Runtime,
    status: string,
    scope: ReturnType<typeof confirmationScopeOf>,
    authorizeOriginals: (questions: readonly OriginalQuestion[]) => void,
  ) => T,
): T {
  const scope = confirmationScopeOf(attempt, ticket);
  let originals: ReadonlyMap<string, OriginalQuestion> | undefined;
  const permits = (request: RecoveryRequest) => permitsRecovery(scope, request);
  return withBoundKernelActivity(
    db,
    dataDir,
    attempt,
    (runtime, activity, stepAttemptId, practiceVersion) => {
      assertConfirmationBinding(scope, { stepAttemptId, practiceVersion });
      return operate(runtime, activity.status, scope, (questions) => {
        originals = new Map(
          questions.map((question) => [question.questionId, question]),
        );
      });
    },
    {
      evaluateScope: () => scope,
      authorizeConfirmationRecovery: permits,
      verifyOriginal(request) {
        const selected = originals?.get(request.questionId);
        return (
          permits(request) &&
          request.slotId === scope.slotId &&
          selected?.questionVersion === request.questionVersion &&
          canonicalJsonOf(selected.original) ===
            canonicalJsonOf(request.original)
        );
      },
    },
  );
}

/** 调用方已在宿主写事务内核实读取权限。按原确认操作补齐宿主投影。 */
export function readKernelConfirmationFacts(
  db: Db,
  dataDir: string,
  attempt: Attempt,
) {
  recoverKernelChoiceAmendment(db, dataDir, attempt.id);
  const ticket = kernelConfirmationTicketFor(db, attempt.id);
  if (!ticket) return undefined;
  return withTicket(db, dataDir, attempt, ticket, (runtime, status, scope) =>
    status === "completed"
      ? recoverKernelConfirmation(db, runtime, scope)
      : undefined,
  );
}

export function readKernelConfirmationResult(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  now: Date,
) {
  const facts = readKernelConfirmationFacts(db, dataDir, attempt);
  return facts === undefined
    ? undefined
    : buildKernelChoiceResult(db, facts, now);
}

function confirmationIntentOf(request: AttemptSubmitRequest): string {
  const byQuestion = (a: { questionId: string }, b: { questionId: string }) =>
    a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0;
  return canonicalJsonOf({
    ...request,
    revisions: request.revisions
      .map((revision) => ({
        ...revision,
        expectedAnswerRevision: revision.expectedAnswerRevision ?? 0,
      }))
      .sort(byQuestion),
    evidence: request.evidence?.toSorted(byQuestion),
  });
}

function stage(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  now: Date,
  request: AttemptSubmitRequest,
): Ticket | undefined {
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      if (attempt.status !== "draft") alreadySubmitted();
      return withBoundKernelActivity(
        db,
        dataDir,
        attempt,
        (_runtime, activity, stepAttemptId, practiceVersion) => {
          if (activity.status === "completed") {
            if (!readKernelConfirmationResult(db, dataDir, attempt, now))
              kernelAttemptUnavailable();
            return undefined;
          }
          assertSavedAnswersConfirmed(
            attempt,
            now,
            request.confirmedSavedAnswers,
          );
          const previous = kernelConfirmationTicketFor(db, attemptId);
          if (previous) {
            assertConfirmationBinding(previous, {
              stepAttemptId,
              practiceVersion,
            });
            if (
              confirmationIntentOf(
                attemptSubmitRequestSchema.parse(previous.request),
              ) === confirmationIntentOf(request)
            ) {
              if (kernelActivitySealOf(previous.request)) return previous;
              const updated = captureKernelConfirmationRequest(
                db,
                attemptId,
                request,
              );
              db.update(kernelAttemptConfirmations)
                .set({ request: updated })
                .where(eq(kernelAttemptConfirmations.attemptId, attemptId))
                .run();
              return { ...previous, request: updated };
            }
            // 内核仍为 active，且持有宿主写锁。只有这时可替换未确认的不同意图。
            discardTicket(db, previous);
          }
          const ticket = {
            attemptId,
            operationId: randomUUID(),
            stepAttemptId,
            practiceVersion,
            request,
          } satisfies Ticket;
          prepareChoiceOriginals(
            db,
            dataDir,
            confirmationScopeOf(attempt, ticket),
            request,
          );
          const staged = {
            ...ticket,
            request: captureKernelConfirmationRequest(db, attemptId, request),
          };
          db.insert(kernelAttemptConfirmations).values(staged).run();
          return staged;
        },
      );
    })
    .immediate();
}

function knownRejection(error: unknown): HttpError | undefined {
  if (error instanceof ChoiceConfirmationConflict) {
    return new HttpError(
      409,
      "ANSWER_REVISION_CONFLICT",
      "本题答案已更新，请核对当前草稿再提交",
      attemptSubmissionConflictSchema.parse({
        _questionId: error.questionId,
        _current: {
          revision: error.current.revision,
          draft:
            error.current.choice === null
              ? null
              : ownClassChoiceAnswerOf(error.current.choice),
        },
      }),
    );
  }
  if (error instanceof LearningError) {
    if (error.code === "QUESTION_REVISION_STALE") return revisionStale();
    if (error.code === "ORIGINAL_NOT_VERIFIED")
      return new HttpError(
        409,
        "NOTE_EVIDENCE_MISMATCH",
        "交卷原稿与冻结版本不一致",
      );
  }
  return undefined;
}

function confirm(
  db: Db,
  dataDir: string,
  studentId: string,
  ticket: Ticket,
  now: Date,
) {
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, ticket.attemptId);
      if (attempt.status !== "draft") alreadySubmitted();
      const current = kernelConfirmationTicketFor(db, ticket.attemptId);
      if (current?.operationId !== ticket.operationId) return undefined;
      return withTicket(
        db,
        dataDir,
        attempt,
        current,
        (runtime, status, scope, authorizeOriginals) => {
          if (status !== "completed") {
            let questions: ReturnType<typeof prepareChoiceOriginals>;
            try {
              questions = prepareChoiceOriginals(
                db,
                dataDir,
                scope,
                attemptSubmitRequestSchema.parse(current.request),
              );
            } catch (error) {
              if (!(error instanceof HttpError) || error.status >= 500)
                throw error;
              discardTicket(db, current);
              return { error };
            }
            authorizeOriginals(questions);
            try {
              runtime.confirmChoices(
                { role: "student", id: studentId },
                attempt.id,
                {
                  protocolVersion: 1,
                  stepAttemptId: current.stepAttemptId,
                  operationId: current.operationId,
                  slotId: scope.slotId,
                  questions,
                },
              );
            } catch (error) {
              const rejection = knownRejection(error);
              if (!rejection) throw error;
              discardTicket(db, current);
              return { error: rejection };
            }
          }
          const facts = recoverKernelConfirmation(db, runtime, scope);
          return { data: buildKernelChoiceResult(db, facts, now) };
        },
      );
    })
    .immediate();
}

export function submitAssignmentAttempt(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  now: Date,
  request: AttemptSubmitRequest,
) {
  if (!isKernelAttempt(db, requireOwnAttempt(db, studentId, attemptId)))
    return submitAttempt(db, studentId, attemptId, now, request);
  // 两阶段之间若另一份有效意图取得预留，重新核验实际权威状态。
  for (let retry = 0; retry < 4; retry++) {
    const ticket = stage(db, dataDir, studentId, attemptId, now, request);
    if (ticket === undefined) alreadySubmitted();
    const result = confirm(db, dataDir, studentId, ticket, now);
    if (result === undefined) continue;
    if (result.error) throw result.error;
    return result.data;
  }
  kernelAttemptUnavailable();
}
