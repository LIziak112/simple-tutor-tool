import { attemptResultDataSchema } from "@tutor/contract";
import { and, eq, gt } from "drizzle-orm";
import type { openLearningRuntime } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts, ink } from "../db/schema.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import {
  type OwnClassChoiceEvaluationScope,
  ownClassChoiceEvaluatorRef,
} from "./attempt-choice-evaluation.ts";
import { projectConfirmedChoiceEvidence } from "./attempt-choice-evidence.ts";
import { buildResultData } from "./attempt-detail.ts";
import { attemptFinalOutcomeOf, scoreAutoOf } from "./attempt-final-outcome.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import {
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
} from "./kernel-assignment-runtime.ts";

type Recovery = ReturnType<
  ReturnType<typeof openLearningRuntime>["recoverChoiceConfirmation"]
>;
type Scope = OwnClassChoiceEvaluationScope & { operationId: string };

/** 从内核确认重建结果，只落宿主卷生命周期和原稿索引。 */
export function projectKernelChoiceFacts(
  db: Db,
  attempt: Attempt,
  scope: Scope,
  recovery: Recovery,
) {
  const { evaluation, confirmation } = recovery;
  const rows = attemptResponseRows(db, attempt.id);
  if (
    !evaluation ||
    evaluation.evaluator.id !== ownClassChoiceEvaluatorRef.id ||
    evaluation.evaluator.version !== ownClassChoiceEvaluatorRef.version ||
    evaluation.questionCount !== rows.length ||
    evaluation.questions.length !== rows.length ||
    confirmation.questions.length !== rows.length ||
    rows.length !== scope.questionRevisions.size ||
    rows.some((row) => row.id !== scope.questionRevisions.get(row.questionId))
  )
    kernelAttemptUnavailable();

  const confirmedById = new Map(
    confirmation.questions.map((item) => [item.questionId, item]),
  );
  const evaluationsById = new Map(
    evaluation.questions.map((item) => [item.questionId, item]),
  );
  const formalInk = new Set(
    db
      .select({ id: ink.questionId })
      .from(ink)
      .where(and(eq(ink.attemptId, attempt.id), gt(ink.strokeCount, 0)))
      .all()
      .map(({ id }) => id),
  );
  const projectedRows = rows.map((row) => {
    const confirmed = confirmedById.get(row.questionId);
    const verdict = evaluationsById.get(row.questionId);
    if (
      !confirmed ||
      confirmed.questionVersion !== row.questionVersion ||
      !verdict ||
      verdict.questionVersion !== row.questionVersion
    )
      kernelAttemptUnavailable();
    const choice =
      confirmed.choice === null
        ? null
        : ownClassChoiceAnswerOf(confirmed.choice);
    return {
      ...row,
      answerJson: choice === null ? null : JSON.stringify(choice),
      answerRevision: confirmed.revision,
      changeCount: confirmed.revision,
      submittedAt:
        attempt.practiceWorkflowVersion === null
          ? null
          : recovery.receipt.confirmedAt,
      answered: choice !== null || formalInk.has(row.questionId),
      autoCorrect: verdict.correct,
      finalCorrect: verdict.correct,
    };
  });
  const outcome = attemptFinalOutcomeOf(projectedRows, { finalized: true });
  const receipt = projectConfirmedChoiceEvidence(db, scope, () => recovery);
  let lifecycle = attempt;
  if (attempt.status === "draft") {
    touchAttemptActivity(db, attempt.id, receipt.confirmedAt);
    const saved = db
      .update(attempts)
      .set({ status: outcome.status, submittedAt: receipt.confirmedAt })
      .where(eq(attempts.id, attempt.id))
      .returning()
      .get();
    if (!saved) kernelAttemptUnavailable();
    lifecycle = saved;
  } else if (
    attempt.status !== outcome.status ||
    attempt.submittedAt !== receipt.confirmedAt
  ) {
    kernelAttemptUnavailable();
  }
  return {
    attempt: {
      ...lifecycle,
      scoreAuto: scoreAutoOf(projectedRows),
      scoreFinal: outcome.scoreFinal,
    },
    rows: projectedRows,
  };
}

export function buildKernelChoiceResult(
  db: Db,
  { attempt, rows }: ReturnType<typeof projectKernelChoiceFacts>,
  now: Date,
) {
  return attemptResultDataSchema.parse(
    buildResultData(db, attempt, now, undefined, rows, 0),
  );
}
