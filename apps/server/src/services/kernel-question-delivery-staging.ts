import { randomUUID } from "node:crypto";
import {
  type AttemptSubmitRequest,
  attemptSubmitRequestSchema,
} from "@tutor/contract";
import {
  type KernelDeliverySource,
  kernelQuestionDeliveryIntentSchema,
} from "@tutor/contract/kernel-question-delivery";
import type { Db } from "../db/client.ts";
import { kernelQuestionDeliveries } from "../db/schema-kernel-question-delivery.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  questionAlreadySubmitted,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-access.ts";
import { prepareKernelOriginals } from "./attempt-choice-evidence.ts";
import { settleSubmissionOriginalReservation } from "./attempt-original-reservation.ts";
import { validateSubmitRevisions } from "./attempt-submit-revisions.ts";
import { assertSavedAnswersConfirmed } from "./attempt-timing.ts";
import { captureKernelConfirmationRequest } from "./kernel-assignment-activity.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  deliveryPolicy,
  type QuestionDeliveryActivity,
} from "./kernel-question-delivery-binding.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";
import {
  recoverDeliveries,
  withDelivery,
} from "./kernel-question-delivery-recovery.ts";
import {
  type DeliveryTicket,
  deliveryTickets,
  ticketFilter,
} from "./kernel-question-delivery-ticket.ts";

export const duplicate = (source: KernelDeliverySource) =>
  source === "question"
    ? questionAlreadySubmitted()
    : new HttpError(409, "ALREADY_SUBMITTED", "这份练习已经交过卷了");

function slotFor(
  view: QuestionDeliveryActivity,
  source: KernelDeliverySource,
  questionId?: string,
) {
  const policy = deliveryPolicy(view);
  if ((source === "whole") !== (policy.mode === "whole"))
    kernelAttemptUnavailable();
  if (source === "question") {
    const slot =
      policy.mode === "perQuestion" &&
      questionId &&
      Object.hasOwn(policy.questionSlots, questionId)
        ? policy.questionSlots[questionId]
        : undefined;
    if (!slot) throw questionNotFound();
    return slot;
  }
  return deliverySlotId;
}

function submittedIntentOf(request: AttemptSubmitRequest) {
  const byQuestion = (a: { questionId: string }, b: { questionId: string }) =>
    a.questionId.localeCompare(b.questionId);
  return canonicalJsonOf({
    ...attemptSubmitRequestSchema.parse(request),
    revisions: request.revisions
      .map((revision) => ({
        ...revision,
        expectedAnswerRevision: revision.expectedAnswerRevision ?? 0,
      }))
      .toSorted(byQuestion),
    evidence: request.evidence?.toSorted(byQuestion),
  });
}

export function stageDelivery(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  source: KernelDeliverySource,
  request: AttemptSubmitRequest,
  now: Date,
) {
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      return withDelivery(
        db,
        dataDir,
        attempt,
        (runtime, binding, view, activate) => {
          const { attempt: current, rows } = recoverDeliveries(
            db,
            runtime,
            attempt,
            binding,
            view,
            activate,
          );
          if (current.status !== "draft")
            return { error: duplicate("whole") } as const;
          const questionId =
            source === "question"
              ? request.revisions[0]?.questionId
              : undefined;
          const slotId = slotFor(view, source, questionId);
          const scope =
            source === "question"
              ? rows.filter((row) => row.questionId === questionId)
              : rows;
          const selected = scope.filter((row) => row.submittedAt === null);
          if (selected.length === 0)
            return { error: duplicate(source) } as const;
          assertSavedAnswersConfirmed(
            current,
            now,
            request.confirmedSavedAnswers,
          );
          validateSubmitRevisions(
            scope.map((response) => ({ response })),
            selected.map((response) => ({ response })),
            request.revisions,
          );
          const previous = deliveryTickets(db, attemptId).find(
            (ticket) => ticket.slotId === slotId,
          );
          if (previous) {
            if (previous.receiptId !== null) kernelAttemptUnavailable();
            if (
              previous.intent.source === source &&
              canonicalJsonOf(previous.intent.selectedQuestionIds) ===
                canonicalJsonOf(selected.map((row) => row.questionId)) &&
              submittedIntentOf(previous.intent) === submittedIntentOf(request)
            )
              return { ticket: previous } as const;
            removePendingTicket(db, previous);
          }
          const operation = {
            attemptId,
            studentId,
            operationId: randomUUID(),
            stepAttemptId: binding.stepAttemptId,
            practiceVersion: binding.practiceVersion,
          };
          const covered = new Set(selected.map(({ questionId }) => questionId));
          const originals = prepareKernelOriginals(
            db,
            dataDir,
            operation,
            request,
            selected,
          );
          const byId = new Map(
            originals.map((item) => [item.questionId, item]),
          );
          const questions = scope.map(
            ({ questionId, questionVersion, answerRevision }) =>
              byId.get(questionId) ?? {
                questionId,
                questionVersion,
                revision: answerRevision,
                original: { state: "uncollected" as const },
              },
          );
          const seal = captureKernelConfirmationRequest(db, attemptId, {
            ...request,
            revisions: request.revisions.filter(({ questionId }) =>
              covered.has(questionId),
            ),
          }).activitySeal;
          const ticket: DeliveryTicket = {
            attemptId,
            stepAttemptId: binding.stepAttemptId,
            slotId,
            practiceVersion: binding.practiceVersion,
            operationId: operation.operationId,
            receiptId: null,
            intent: kernelQuestionDeliveryIntentSchema.parse({
              ...request,
              source,
              selectedQuestionIds: [...covered],
              questions,
              activitySeal: seal,
            }),
          };
          db.insert(kernelQuestionDeliveries).values(ticket).run();
          return { ticket } as const;
        },
      );
    })
    .immediate();
}

export function removePendingTicket(db: Db, ticket: DeliveryTicket) {
  if (ticket.receiptId !== null) kernelAttemptUnavailable();
  settleSubmissionOriginalReservation(db, ticket, "aborted");
  db.delete(kernelQuestionDeliveries).where(ticketFilter(ticket)).run();
}
