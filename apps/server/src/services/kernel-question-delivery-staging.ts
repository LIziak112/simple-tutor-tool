import { randomUUID } from "node:crypto";
import {
  type AttemptSubmitRequest,
  attemptSubmitRequestSchema,
} from "@tutor/contract";
import {
  type KernelDeliverySource,
  type KernelPracticeSubmission,
  kernelQuestionDeliveryIntentSchema,
} from "@tutor/contract/kernel-question-delivery";
import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
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
import {
  assertAttemptNotTimedOut,
  assertSavedAnswersConfirmed,
} from "./attempt-timing.ts";
import {
  captureFormalInkAnchor,
  needsFormalInkAnchor,
} from "./formal-ink-attachment.ts";
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
import { attemptWorkflowView } from "./practice-workflow-wiring.ts";

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

export function checkPracticeDelivery(
  db: Db,
  attempt: Attempt,
  row: ResponseRow | undefined,
  practice: KernelPracticeSubmission,
  now: Date,
): "replayed" | undefined {
  if (!row) throw questionNotFound();
  if (row.submittedAt !== null) {
    if (row.practiceMutationId !== practice.mutationId)
      throw questionAlreadySubmitted();
    if (row.practiceRequestDigest !== practice.digest)
      throw new HttpError(
        409,
        "WORKFLOW_MUTATION_CONFLICT",
        "同一提交标识的请求内容不一致，请刷新页面后重试",
      );
    return "replayed";
  }
  if (attempt.status !== "draft") throw duplicate("whole");
  assertAttemptNotTimedOut(attempt, now, "running");
  if (
    !attemptWorkflowView(db, attempt, now)?.practiceWorkflow.canSubmitQuestion
  )
    throw new HttpError(
      409,
      "WORKFLOW_RESTRICTED",
      "当前规则不允许逐题提交，请继续完成剩余题目并交卷",
    );
  if (practice.workflowRevision !== attempt.workflowRevision)
    throw new HttpError(
      409,
      "WORKFLOW_REVISION_STALE",
      "做题设置已在其他设备修改，请刷新后重试",
    );
  return undefined;
}

export function stageDelivery(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  requestedSource: KernelDeliverySource,
  request: AttemptSubmitRequest,
  now: Date,
  practiceSubmission?: KernelPracticeSubmission,
) {
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      return withDelivery(
        db,
        dataDir,
        attempt,
        (runtime, binding, view, activate, attempt) => {
          const facts = recoverDeliveries(
            db,
            dataDir,
            runtime,
            attempt,
            binding,
            view,
            activate,
          );
          const { attempt: current, rows } = facts;
          const source =
            requestedSource === "whole" &&
            binding.course &&
            deliveryPolicy(view).mode === "perQuestion"
              ? "finish"
              : requestedSource;
          const questionId =
            source === "question"
              ? request.revisions[0]?.questionId
              : undefined;
          if (
            practiceSubmission &&
            checkPracticeDelivery(
              db,
              current,
              rows.find((row) => row.questionId === questionId),
              practiceSubmission,
              now,
            ) === "replayed"
          )
            return { facts } as const;
          if (current.status !== "draft")
            return { error: duplicate("whole") } as const;
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
          const formalInk =
            source === "whole"
              ? selected
                  .filter(needsFormalInkAnchor)
                  .map(({ questionId }) =>
                    captureFormalInkAnchor(db, dataDir, attemptId, questionId),
                  )
              : [];
          const previous = deliveryTickets(db, attemptId).find(
            (ticket) => ticket.slotId === slotId,
          );
          if (previous) {
            if (previous.receiptId !== null) kernelAttemptUnavailable();
            if (
              previous.intent.source === source &&
              canonicalJsonOf(previous.intent.selectedQuestionIds) ===
                canonicalJsonOf(selected.map((row) => row.questionId)) &&
              submittedIntentOf(previous.intent) ===
                submittedIntentOf(request) &&
              previous.intent.practiceSubmission?.mutationId ===
                practiceSubmission?.mutationId &&
              previous.intent.practiceSubmission?.digest ===
                practiceSubmission?.digest &&
              canonicalJsonOf(previous.intent.formalInk ?? []) ===
                canonicalJsonOf(formalInk)
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
              ...(practiceSubmission && { practiceSubmission }),
              ...(formalInk.length > 0 && { formalInk }),
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
