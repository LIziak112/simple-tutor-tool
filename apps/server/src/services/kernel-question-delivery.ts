import {
  type AttemptAnswerSaveRequest,
  type AttemptSubmitRequest,
  attemptAnswerConflictCurrentSchema,
  attemptAnswerSaveDataSchema,
  attemptSubmissionConflictSchema,
  type StudentAnswer,
} from "@tutor/contract";
import type { KernelDeliverySource } from "@tutor/contract/kernel-question-delivery";
import {
  LearningError,
  QuestionDeliveryConflict,
  type QuestionDeliveryInput,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { ResponseRow } from "../db/schema.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  questionAlreadySubmitted,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-access.ts";
import {
  assertAttemptWriteProof,
  touchAttemptActivity,
} from "./attempt-activity.ts";
import { prepareKernelOriginals } from "./attempt-choice-evidence.ts";
import { revisionStale } from "./attempt-submit-revisions.ts";
import { attemptTimingOf } from "./attempt-timing.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { readBoundQuestionDelivery } from "./kernel-question-delivery-binding.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";
import {
  actorOf,
  type DeliveryFacts,
  keyOf,
  recoverDeliveries,
  withDelivery,
} from "./kernel-question-delivery-recovery.ts";
import {
  duplicate,
  removePendingTicket,
  stageDelivery,
} from "./kernel-question-delivery-staging.ts";
import { deliveryTickets } from "./kernel-question-delivery-ticket.ts";
import {
  deliveryAnswerOf,
  deliveryValueOf,
  invalidDeliveryAnswer,
} from "./kernel-question-delivery-values.ts";

export { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";

function saveProofError(error: unknown, row: ResponseRow) {
  if (error instanceof QuestionDeliveryConflict) {
    const current = attemptAnswerConflictCurrentSchema.parse({
      revision: error.current.revision,
      draft: deliveryAnswerOf(row, error.current.value),
    });
    throw new HttpError(409, error.code, "答案已变化，请刷新后核对原稿", {
      _current: current,
    });
  }
  if (error instanceof LearningError) {
    if (error.code === "ALREADY_SUBMITTED") throw questionAlreadySubmitted();
    if (error.code === "QUESTION_REVISION_STALE") throw revisionStale();
    if (
      ["INVALID_OPTION_INDEX", "INVALID_RESPONSE", "INVALID_CHOICE"].includes(
        error.code,
      )
    )
      invalidDeliveryAnswer();
  }
  throw error;
}

export function saveQuestionDeliveryAnswer(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
  proof: Pick<
    AttemptAnswerSaveRequest,
    "baseRevision" | "mutationId" | "expectedFrozenAt" | "questionRevisionId"
  >,
) {
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      return withDelivery(
        db,
        dataDir,
        attempt,
        (runtime, binding, view, activate) => {
          const facts = recoverDeliveries(
            db,
            dataDir,
            runtime,
            attempt,
            binding,
            view,
            activate,
          );
          if (facts.attempt.status !== "draft")
            return { error: duplicate("whole") };
          const row = facts.rows.find((item) => item.questionId === questionId);
          if (!row) throw questionNotFound();
          if (row.submittedAt !== null) return { error: duplicate("question") };
          assertAttemptWriteProof(
            attempt,
            proof,
            proof.questionRevisionId,
            row.id,
          );
          if (
            proof.baseRevision === undefined ||
            proof.mutationId === undefined
          )
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              "本次作答须提供答案版本和操作标识",
            );
          const value = deliveryValueOf(row, answer);
          const now = new Date();
          try {
            const result = runtime.saveQuestionDeliveryDraft(
              actorOf(attempt),
              attempt.id,
              {
                protocolVersion: 1,
                stepAttemptId: binding.stepAttemptId,
                slotId: deliverySlotId,
                questionId,
                questionVersion: row.questionVersion,
                value,
                baseRevision: proof.baseRevision,
                operationId: proof.mutationId,
              },
              attemptTimingOf(attempt, now)?.phase === "locked"
                ? "replayLatestOnly"
                : "save",
            );
            touchAttemptActivity(db, attempt.id, now.toISOString());
            return { data: attemptAnswerSaveDataSchema.parse(result) };
          } catch (error) {
            return saveProofError(error, row);
          }
        },
      );
    })
    .immediate();
}

export function submitQuestionDelivery(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  source: KernelDeliverySource,
  request: AttemptSubmitRequest,
  now: Date,
): { facts?: DeliveryFacts; error?: HttpError } | undefined {
  const stage = stageDelivery(
    db,
    dataDir,
    studentId,
    attemptId,
    source,
    request,
    now,
  );
  if (!stage || "error" in stage) return stage;
  const { ticket } = stage;
  return db.$client
    .transaction(() => {
      const attempt = requireUsableAttempt(db, studentId, attemptId);
      return withDelivery(
        db,
        dataDir,
        attempt,
        (runtime, binding, view, activate) => {
          const before = recoverDeliveries(
            db,
            dataDir,
            runtime,
            attempt,
            binding,
            view,
            activate,
          );
          const current = deliveryTickets(db, attemptId).find(
            (item) => item.slotId === ticket.slotId,
          );
          if (current?.receiptId) return { error: duplicate(source) };
          if (
            before.attempt.status !== "draft" ||
            current?.operationId !== ticket.operationId
          )
            return { error: duplicate(source) };
          const selected = before.rows.filter(
            (row) =>
              row.submittedAt === null &&
              ticket.intent.revisions.some(
                (q) => q.questionId === row.questionId,
              ),
          );
          if (
            selected.length !== ticket.intent.selectedQuestionIds.length ||
            selected.some(
              (row) =>
                !ticket.intent.selectedQuestionIds.includes(row.questionId),
            )
          ) {
            removePendingTicket(db, current);
            return { error: revisionStale() };
          }
          let originals: ReturnType<typeof prepareKernelOriginals>;
          try {
            originals = prepareKernelOriginals(
              db,
              dataDir,
              { ...current, studentId },
              current.intent,
              selected,
            );
          } catch (error) {
            if (!(error instanceof HttpError) || error.status >= 500)
              throw error;
            removePendingTicket(db, current);
            return { error };
          }
          const questions = current.intent.questions;
          const recorded = questions.filter((question) =>
            current.intent.selectedQuestionIds.includes(question.questionId),
          );
          if (canonicalJsonOf(originals) !== canonicalJsonOf(recorded)) {
            removePendingTicket(db, current);
            return {
              error: new HttpError(
                409,
                "NOTE_EVIDENCE_MISMATCH",
                "原稿与本次冻结版本不一致",
              ),
            };
          }
          const base = { ...keyOf(current), slotId: deliverySlotId };
          let input: QuestionDeliveryInput;
          if (source === "question") {
            if (questions.length !== 1 || !questions[0])
              kernelAttemptUnavailable();
            input = { ...base, source, questions: [questions[0]] };
          } else input = { ...base, source, questions };
          activate(current);
          try {
            runtime.confirmQuestionDelivery(
              actorOf(attempt),
              attempt.id,
              input,
            );
          } catch (error) {
            const rejection = confirmationError(error, before.rows, source);
            if (!rejection) throw error;
            removePendingTicket(db, current);
            return { error: rejection };
          }
          const activity = readBoundQuestionDelivery(runtime, attempt, binding);
          if (!activity) kernelAttemptUnavailable();
          return {
            facts: recoverDeliveries(
              db,
              dataDir,
              runtime,
              attempt,
              binding,
              activity,
              activate,
            ),
          };
        },
      );
    })
    .immediate();
}

function confirmationError(
  error: unknown,
  rows: readonly ResponseRow[],
  source: KernelDeliverySource,
) {
  if (error instanceof QuestionDeliveryConflict) {
    const row = rows.find((item) => item.questionId === error.questionId);
    if (!row) kernelAttemptUnavailable();
    return new HttpError(
      409,
      "ANSWER_REVISION_CONFLICT",
      "答案已更新，请刷新后核对草稿",
      attemptSubmissionConflictSchema.parse({
        _questionId: row.questionId,
        _current: {
          revision: error.current.revision,
          draft: deliveryAnswerOf(row, error.current.value),
        },
      }),
    );
  }
  if (error instanceof LearningError) {
    if (error.code === "ALREADY_SUBMITTED") return duplicate(source);
    if (error.code === "QUESTION_REVISION_STALE") return revisionStale();
    if (error.code === "ORIGINAL_NOT_VERIFIED")
      return new HttpError(
        409,
        "NOTE_EVIDENCE_MISMATCH",
        "原稿与本次冻结版本不一致",
      );
  }
  return undefined;
}
