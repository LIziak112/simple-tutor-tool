import { attemptResultDataSchema } from "@tutor/contract";
import { isUnanswered } from "@tutor/grading";
import { and, eq, gt } from "drizzle-orm";
import type { openLearningRuntime } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts, ink, type ResponseRow } from "../db/schema.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import {
  type OwnClassChoiceEvaluationScope,
  ownClassChoiceEvaluatorRef,
  ownClassJudgeEvaluatorRef,
} from "./attempt-choice-evaluation.ts";
import { projectConfirmedChoiceEvidence } from "./attempt-choice-evidence.ts";
import { buildResultData } from "./attempt-detail.ts";
import {
  attemptFinalOutcomeOf,
  needsTeacherMark,
  scoreAutoOf,
} from "./attempt-final-outcome.ts";
import { projectKernelConfirmedActivity } from "./kernel-assignment-activity.ts";
import {
  judgeAnswerOf,
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
} from "./kernel-assignment-runtime.ts";
import { recordedActiveSecTotal } from "./submission-time.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;
type Recovery = ReturnType<
  Runtime["recoverChoiceConfirmation"] | Runtime["recoverResponseConfirmation"]
>;
type Scope = OwnClassChoiceEvaluationScope & { operationId: string };
type ProjectedVerdict = {
  questionId: string;
  questionVersion: number;
  correct: boolean | null;
};

function factsOf(recovery: Recovery) {
  if ("responseDraftChangeCounts" in recovery) {
    return {
      evaluator: ownClassJudgeEvaluatorRef,
      counts: recovery.responseDraftChangeCounts,
      answers: recovery.confirmation.questions.map(
        ({ value, ...question }) => ({
          ...question,
          answer: judgeAnswerOf(value),
        }),
      ),
      verdicts: recovery.evaluation.questions.map(
        ({ result, ...question }): ProjectedVerdict => ({
          ...question,
          correct: result.status === "judged" ? result.correct : null,
        }),
      ),
    };
  }
  if (!recovery.evaluation) kernelAttemptUnavailable();
  return {
    evaluator: ownClassChoiceEvaluatorRef,
    counts: recovery.choiceDraftChangeCounts,
    answers: recovery.confirmation.questions.map(({ choice, ...question }) => ({
      ...question,
      answer: choice === null ? null : ownClassChoiceAnswerOf(choice),
    })),
    verdicts: recovery.evaluation.questions,
  };
}

/** 从内核确认重建结果，只落宿主卷生命周期、原稿索引和活动统计。 */
export function projectKernelConfirmationFacts(
  db: Db,
  attempt: Attempt,
  scope: Scope,
  rows: readonly ResponseRow[],
  recovery: Recovery,
) {
  const { evaluation } = recovery;
  const facts = factsOf(recovery);
  if (
    !evaluation ||
    evaluation.evaluator.id !== facts.evaluator.id ||
    evaluation.evaluator.version !== facts.evaluator.version ||
    evaluation.questionCount !== rows.length ||
    facts.verdicts.length !== rows.length ||
    facts.answers.length !== rows.length ||
    rows.length !== scope.questionRevisions.size ||
    rows.some((row) => row.id !== scope.questionRevisions.get(row.questionId))
  )
    kernelAttemptUnavailable();

  const confirmedById = new Map(
    facts.answers.map((item) => [item.questionId, item]),
  );
  const evaluationsById = new Map(
    facts.verdicts.map((item) => [item.questionId, item]),
  );
  const formalInk = new Set(
    db
      .select({ id: ink.questionId })
      .from(ink)
      .where(and(eq(ink.attemptId, attempt.id), gt(ink.strokeCount, 0)))
      .all()
      .map(({ id }) => id),
  );
  const measuredRows = projectKernelConfirmedActivity(
    db,
    attempt,
    scope.operationId,
    recovery.receipt.confirmedAt,
    rows,
    facts.counts,
  );
  const projectedRows = measuredRows.map((row) => {
    const confirmed = confirmedById.get(row.questionId);
    const verdict = evaluationsById.get(row.questionId);
    if (
      !confirmed ||
      confirmed.questionVersion !== row.questionVersion ||
      !verdict ||
      verdict.questionVersion !== row.questionVersion
    )
      kernelAttemptUnavailable();
    return {
      ...row,
      answerJson:
        confirmed.answer === null ? null : JSON.stringify(confirmed.answer),
      answerRevision: confirmed.revision,
      submittedAt:
        attempt.practiceWorkflowVersion === null
          ? null
          : recovery.receipt.confirmedAt,
      answered:
        !isUnanswered(confirmed.answer ?? undefined) ||
        formalInk.has(row.questionId),
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
      .set({
        status: outcome.status,
        submittedAt: receipt.confirmedAt,
        activeSec: recordedActiveSecTotal(projectedRows),
      })
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

export function buildKernelAssignmentResult(
  db: Db,
  { attempt, rows }: ReturnType<typeof projectKernelConfirmationFacts>,
  now: Date,
) {
  return attemptResultDataSchema.parse(
    buildResultData(
      db,
      attempt,
      now,
      undefined,
      rows,
      rows.filter(needsTeacherMark).length,
    ),
  );
}
