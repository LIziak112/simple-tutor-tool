import { type Question, singleChoiceScoringSourceSchema } from "@tutor/contract";
import { gradeResponseRow } from "@tutor/grading";
import type {
  ChoiceEvaluationInput,
  ChoiceEvaluatorRegistration,
  IndexResponseEvaluationInput,
  IndexResponseEvaluatorRegistration,
  ResponseEvaluationInput,
  ResponseEvaluatorRegistration,
  ResponseVerdict,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  buildAttemptQuestionWhere,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { snapshotOfRow } from "./snapshot.ts";

export const ownClassChoiceEvaluatorRef = {
  id: "ownclass-choice",
  version: 1,
} as const;

export type OwnClassChoiceEvaluationScope = Readonly<{
  attemptId: string;
  studentId: string;
  assignmentId: string;
  stepAttemptId: string;
  slotId: string;
  practiceVersion: number;
  questionRevisions: ReadonlyMap<string, string>;
}>;

function mismatch(): never {
  throw new HttpError(
    409,
    "CHOICE_EVALUATION_SCOPE_MISMATCH",
    "冻结的作答评分来源已变化",
  );
}

export const ownClassJudgeEvaluatorRef = {
  id: "ownclass-judge",
  version: 1,
} as const;

export const ownClassMultiEvaluatorRef = {
  id: "ownclass-multi",
  version: 1,
} as const;

export function multiScoringSourceOf({ type, options, answers }: Question) {
  if (type !== "multi" || answers?.kind !== "multi" || !options?.length ||
      answers.indexes.some((index) => options[index] === undefined)) return undefined;
  return { options, indexes: answers.indexes };
}

function frozenQuestionForEvaluation(
  db: Db,
  scope: OwnClassChoiceEvaluationScope | undefined,
  input: ChoiceEvaluationInput | ResponseEvaluationInput | IndexResponseEvaluationInput,
) {
  if (
    scope === undefined ||
    input.activityId !== scope.attemptId ||
    input.stepAttemptId !== scope.stepAttemptId ||
    input.slotId !== scope.slotId ||
    input.practice.id !== scope.assignmentId ||
    input.practice.version !== scope.practiceVersion
  )
    mismatch();
  const attempt = requireOwnAttempt(db, scope.studentId, scope.attemptId);
  if (
    attempt.sourceType !== "assignment" ||
    attempt.assignmentId !== scope.assignmentId ||
    attempt.abandonedAt !== null ||
    attempt.frozenAt === null
  )
    mismatch();
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attempt.id, input.questionId))
    .get();
  if (
    row === undefined ||
    row.id !== scope.questionRevisions.get(input.questionId) ||
    row.questionVersion !== input.questionVersion ||
    row.gradingPolicy !== "auto"
  )
    mismatch();
  const question = snapshotOfRow(row);
  if (question?.id !== input.questionId) mismatch();
  return { row, question };
}

/** 仅供可信回执恢复调用。以宿主冻结行校验评分来源，将实际答案交给统一判分入口。 */
export function createOwnClassChoiceEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): ChoiceEvaluatorRegistration {
  return {
    ...ownClassChoiceEvaluatorRef,
    evaluate(input: ChoiceEvaluationInput): boolean {
      const { row, question } = frozenQuestionForEvaluation(
        db,
        currentScope(),
        input,
      );
      const source = singleChoiceScoringSourceSchema.safeParse(question);
      if (
        !source.success ||
        String(source.data.answers.index) !== input.acceptedChoice
      )
        mismatch();
      const index = input.choice === null ? undefined : Number(input.choice);
      if (
        index !== undefined &&
        (String(index) !== input.choice || !source.data.options[index])
      )
        mismatch();
      const verdict = gradeResponseRow(
        row.gradingPolicy,
        question,
        index === undefined ? undefined : { kind: "choice", index },
      );
      if (verdict === null) mismatch();
      return verdict;
    },
  };
}

export function createOwnClassJudgeEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): ResponseEvaluatorRegistration {
  return {
    ...ownClassJudgeEvaluatorRef,
    evaluate(input): ResponseVerdict {
      const { row, question } = frozenQuestionForEvaluation(
        db,
        currentScope(),
        input,
      );
      if (
        question.type !== "judge" ||
        question.answers?.kind !== "judge" ||
        question.answers.value !== input.acceptedResponse
      )
        mismatch();
      const result = gradeResponseRow(
        row.gradingPolicy,
        question,
        input.value === null
          ? undefined
          : { kind: "judge", value: input.value },
      );
      return result === null
        ? { status: "needsReview" }
        : { status: "judged", correct: result };
    },
  };
}

/** 同一冻结题校验多选集合来源；实际判分仍使用产品的集合规则。 */
export function createOwnClassMultiEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): IndexResponseEvaluatorRegistration {
  return {
    ...ownClassMultiEvaluatorRef,
    evaluate(input) {
      const { row, question } = frozenQuestionForEvaluation(db, currentScope(), input);
      const source = multiScoringSourceOf(question);
      if (!source || source.indexes.length !== input.acceptedIndexes.length ||
          source.indexes.some((index, position) => index !== input.acceptedIndexes[position]) ||
          input.value?.some((index) => source.options[index] === undefined)) mismatch();
      const verdict = gradeResponseRow(row.gradingPolicy, question,
        input.value === null ? undefined : { kind: "multi", indexes: [...input.value] });
      if (verdict === null) mismatch();
      return { status: "judged", correct: verdict };
    },
  };
}
