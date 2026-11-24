import { isTeacherReviewDeliveryScoringSource } from "@tutor/contract";
import { kernelDeliveryOriginalSchema } from "@tutor/contract/kernel-question-delivery";
import { isUnanswered } from "@tutor/grading";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  attemptSettlements,
  attempts,
  ink,
  type ResponseRow,
  responses,
} from "../db/schema.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { ownClassDeliveryEvaluatorRef } from "./attempt-choice-evaluation.ts";
import { projectKernelEvidence } from "./attempt-choice-evidence.ts";
import { attemptFinalOutcomeOf, scoreAutoOf } from "./attempt-final-outcome.ts";
import { writeFinalSettlementWithin } from "./attempt-settlement.ts";
import { sealResponseTimeWithin } from "./attempt-time-seal.ts";
import {
  recordConfirmedSubmit,
  recordQuestionSubmitEvent,
} from "./event-service.ts";
import type { KernelRuntime } from "./kernel-assignment-runtime.ts";
import {
  kernelAttemptUnavailable,
  recoverEvaluated,
  requireEvaluated,
} from "./kernel-assignment-runtime.ts";
import type { DeliveryTicket } from "./kernel-question-delivery-ticket.ts";
import { deliveryAnswerOf } from "./kernel-question-delivery-values.ts";
import { snapshotOfRow } from "./snapshot.ts";
import { recordedActiveSecTotal } from "./submission-time.ts";

type Recovery = ReturnType<typeof declaredDeliveryRecovery>;

export function declaredDeliveryRecovery(
  runtime: KernelRuntime,
  actor: Parameters<KernelRuntime["recoverQuestionDelivery"]>[0],
  attemptId: string,
  key: Parameters<KernelRuntime["recoverQuestionDelivery"]>[2],
) {
  return recoverEvaluated(
    runtime,
    () => runtime.recoverQuestionDelivery(actor, attemptId, key, "declared"),
    (recovered) =>
      recovered.assessment === "automatic"
        ? recovered.evaluation.status
        : undefined,
  );
}

export function projectDeliveryRows(
  db: Db,
  attempt: Attempt,
  ticket: DeliveryTicket,
  recovery: Recovery,
  selected: readonly ResponseRow[],
) {
  const { activitySeal, source, practiceSubmission } = ticket.intent;
  if (
    recovery.assessment !== "automatic" &&
    recovery.assessment !== "teacherReview"
  )
    kernelAttemptUnavailable();
  const { receipt, confirmation, review } = recovery;
  const evaluation =
    recovery.assessment === "automatic"
      ? requireEvaluated(recovery.evaluation)
      : undefined;
  const formalInk = new Set(
    db
      .select({ id: ink.questionId })
      .from(ink)
      .where(and(eq(ink.attemptId, attempt.id), gt(ink.strokeCount, 0)))
      .all()
      .map((row) => row.id),
  );
  for (const { questionId, ink: anchor } of ticket.intent.formalInk ?? []) {
    if (anchor && anchor.strokeCount > 0) formalInk.add(questionId);
    else formalInk.delete(questionId);
  }
  const byQuestion = new Map(
    confirmation.questions.map((question) => [question.questionId, question]),
  );
  const verdicts = new Map(
    evaluation?.questions.map((question) => [question.questionId, question]),
  );
  const required = new Map(
    review?.questions.map((question) => [question.questionId, question]),
  );
  const seals = new Map(
    activitySeal.responses.map((row) => [row.responseId, row]),
  );
  const counts = new Map(
    recovery.draftChangeCounts.map((row) => [row.questionId, row.changeCount]),
  );
  if (
    (evaluation &&
      (evaluation.evaluator.id !== ownClassDeliveryEvaluatorRef.id ||
        evaluation.evaluator.version !== ownClassDeliveryEvaluatorRef.version ||
        verdicts.size === 0)) ||
    byQuestion.size !== selected.length ||
    verdicts.size !== (evaluation?.questions.length ?? 0) ||
    required.size !== (review?.questions.length ?? 0) ||
    verdicts.size + required.size !== selected.length ||
    seals.size !== selected.length ||
    canonicalJsonOf(recovery.requestQuestions.toSorted(byId)) !==
      canonicalJsonOf(ticket.intent.questions.toSorted(byId))
  )
    kernelAttemptUnavailable();
  const rows = selected.map((row) => {
    const question = byQuestion.get(row.questionId);
    const evaluated = verdicts.get(row.questionId);
    const reviewRequired = required.get(row.questionId);
    const teacherReview = isTeacherReviewDeliveryScoringSource(
      snapshotOfRow(row),
    );
    const seal = seals.get(row.id);
    const revision = ticket.intent.revisions.find(
      (item) => item.questionId === row.questionId,
    );
    if (
      !question ||
      (teacherReview
        ? source !== "whole" ||
          row.gradingPolicy !== "manual_only" ||
          reviewRequired?.questionVersion !== row.questionVersion ||
          evaluated !== undefined
        : evaluated?.questionVersion !== row.questionVersion ||
          reviewRequired !== undefined) ||
      !seal ||
      row.id !== revision?.questionRevisionId ||
      question.questionVersion !== row.questionVersion
    )
      kernelAttemptUnavailable();
    const answer = deliveryAnswerOf(row, question.value);
    const deliberate = source === "question";
    const empty =
      isUnanswered(answer ?? undefined) && !formalInk.has(row.questionId);
    const result =
      evaluated?.result.status === "judged" ? evaluated.result.correct : null;
    const submittedAt =
      attempt.sourceType === "lesson" ||
      attempt.practiceWorkflowVersion !== null
        ? receipt.confirmedAt
        : null;
    const studentFlag =
      deliberate && empty ? ("unsure" as const) : row.studentFlag;
    return {
      ...row,
      submittedAt,
      studentFlag,
      answered: deliberate || !empty,
      answerJson: answer === null ? null : JSON.stringify(answer),
      answerRevision: question.revision,
      autoCorrect: result,
      finalCorrect: result,
      activeSec: seal.activeSec,
      changeCount: Math.max(seal.changeCount, counts.get(row.questionId) ?? 0),
      ...(practiceSubmission && {
        practiceMutationId: practiceSubmission.mutationId,
        practiceRequestDigest: practiceSubmission.digest,
      }),
    };
  });

  projectKernelEvidence(
    db,
    {
      attemptId: attempt.id,
      studentId: attempt.studentId,
      operationId: ticket.operationId,
      stepAttemptId: ticket.stepAttemptId,
      practiceVersion: ticket.practiceVersion,
    },
    receipt,
    confirmation.questions.map((q) => ({
      ...q,
      original: kernelDeliveryOriginalSchema.parse(q.original),
    })),
    selected,
    ticket.receiptId !== null,
  );

  if (ticket.receiptId !== null) {
    if (
      ticket.receiptId !== receipt.id ||
      rows.some(
        (row, index) =>
          row.submittedAt !== selected[index]?.submittedAt ||
          row.studentFlag !== selected[index]?.studentFlag ||
          row.answered !== selected[index]?.answered ||
          row.practiceMutationId !== selected[index]?.practiceMutationId ||
          row.practiceRequestDigest !== selected[index]?.practiceRequestDigest,
      )
    )
      kernelAttemptUnavailable();
    return rows;
  }

  sealResponseTimeWithin(
    db,
    attempt.id,
    rows.map(({ id }) => id),
    receipt.confirmedAt,
    activitySeal.receivedThroughSeq,
  );
  for (const {
    id,
    submittedAt,
    studentFlag,
    answered,
    activeSec,
    changeCount,
    practiceMutationId,
    practiceRequestDigest,
  } of rows) {
    db.update(responses)
      .set({
        submittedAt,
        studentFlag,
        answered,
        activeSec,
        changeCount,
        practiceMutationId,
        practiceRequestDigest,
      })
      .where(eq(responses.id, id))
      .run();
  }
  if (source === "question") {
    for (const row of rows)
      recordQuestionSubmitEvent(
        db,
        attempt.studentId,
        attempt.id,
        row.questionId,
        receipt.confirmedAt,
      );
  }
  return rows;
}

function byId(a: { questionId: string }, b: { questionId: string }) {
  return a.questionId.localeCompare(b.questionId);
}

export function projectDeliveryCompletion(
  db: Db,
  attempt: Attempt,
  rows: readonly ResponseRow[],
  confirmedAt: string,
  verdictsChanged = false,
) {
  const outcome = attemptFinalOutcomeOf(rows, { finalized: true });
  let lifecycle = attempt;
  let seq: number;
  if (attempt.status === "draft") {
    const saved = db
      .update(attempts)
      .set({
        submittedAt: confirmedAt,
        status: outcome.status,
        activeSec: recordedActiveSecTotal(rows),
        lastActivityAt: confirmedAt,
      })
      .where(eq(attempts.id, attempt.id))
      .returning()
      .get();
    if (!saved) kernelAttemptUnavailable();
    recordConfirmedSubmit(db, attempt, confirmedAt);
    seq = writeFinalSettlementWithin(db, attempt.id).seq;
    lifecycle = saved;
  } else {
    if (
      (!verdictsChanged && attempt.status !== outcome.status) ||
      attempt.submittedAt !== confirmedAt
    )
      kernelAttemptUnavailable();
    const settlement = db
      .select()
      .from(attemptSettlements)
      .where(
        and(
          eq(attemptSettlements.attemptId, attempt.id),
          eq(attemptSettlements.kind, "final"),
        ),
      )
      .get();
    if (
      !settlement ||
      settlement.createdAt !== confirmedAt ||
      settlement.questionCount !== rows.length ||
      rows.some((row) => row.settlementSeq !== settlement.seq)
    )
      kernelAttemptUnavailable();
    seq = settlement.seq;
  }
  return {
    attempt: {
      ...lifecycle,
      scoreAuto: scoreAutoOf(rows),
      ...outcome,
    },
    rows: rows.map((row) => ({
      ...row,
      settlementSeq: row.settlementSeq ?? seq,
    })),
  };
}
