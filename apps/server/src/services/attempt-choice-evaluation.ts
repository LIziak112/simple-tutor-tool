import {
  type GradingPolicy,
  judgeScoringSourceSchema,
  multiChoiceScoringSourceSchema,
  orderedTextDeliveryScoringSourceSchema,
  responseDeliveryScoringSourceSchema,
  singleChoiceScoringSourceSchema,
} from "@tutor/contract";
import { gradeResponseRow } from "@tutor/grading";
import type {
  ChoiceEvaluationInput,
  ChoiceEvaluatorRegistration,
  IndexResponseEvaluationInput,
  IndexResponseEvaluatorRegistration,
  OrderedTextEvaluationInput,
  OrderedTextEvaluatorRegistration,
  ResponseEvaluationInput,
  ResponseEvaluatorRegistration,
  ResponseVerdict,
  TitledTextEvaluationInput,
  TitledTextEvaluatorRegistration,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  buildAttemptQuestionWhere,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { deliveryAnswerOf } from "./kernel-question-delivery-values.ts";
import { snapshotOfRow } from "./snapshot.ts";

export const ownClassChoiceEvaluatorRef = {
  id: "ownclass-choice",
  version: 1,
} as const;

export type OwnClassChoiceEvaluationScope = Readonly<{
  attemptId: string;
  studentId: string;
  assignmentId: string;
  lectureId?: string;
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

function frozenQuestionForEvaluation(
  db: Db,
  scope: OwnClassChoiceEvaluationScope | undefined,
  input:
    | ChoiceEvaluationInput
    | ResponseEvaluationInput
    | IndexResponseEvaluationInput
    | OrderedTextEvaluationInput
    | TitledTextEvaluationInput,
  permittedPolicies: readonly GradingPolicy[] = ["auto"],
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
    (scope.lectureId === undefined
      ? attempt.sourceType !== "assignment" ||
        attempt.assignmentId !== scope.assignmentId
      : attempt.sourceType !== "lesson" ||
        attempt.lectureId !== scope.lectureId) ||
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
    row.gradingPolicy === null ||
    !permittedPolicies.includes(row.gradingPolicy)
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
  reference = ownClassChoiceEvaluatorRef as Readonly<{
    id: string;
    version: number;
  }>,
): ChoiceEvaluatorRegistration {
  return {
    ...reference,
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
  reference = ownClassJudgeEvaluatorRef as Readonly<{
    id: string;
    version: number;
  }>,
): ResponseEvaluatorRegistration {
  return {
    ...reference,
    evaluate(input): ResponseVerdict {
      const { row, question } = frozenQuestionForEvaluation(
        db,
        currentScope(),
        input,
      );
      const source = judgeScoringSourceSchema.safeParse(question);
      if (
        !source.success ||
        source.data.answers.value !== input.acceptedResponse
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

export const ownClassDeliveryEvaluatorRef = {
  id: "ownclass-question-delivery",
  version: 1,
} as const;

export function createOwnClassMultiEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): IndexResponseEvaluatorRegistration {
  return {
    ...ownClassDeliveryEvaluatorRef,
    evaluate(input) {
      const { row, question } = frozenQuestionForEvaluation(
        db,
        currentScope(),
        input,
      );
      const source = multiChoiceScoringSourceSchema.safeParse(question);
      if (
        !source.success ||
        JSON.stringify(source.data.answers.indexes) !==
          JSON.stringify(input.acceptedIndexes) ||
        input.value?.some((index) => !source.data.options[index])
      )
        mismatch();
      const result = gradeResponseRow(
        row.gradingPolicy,
        question,
        input.value === null
          ? undefined
          : { kind: "multi", indexes: [...input.value] },
      );
      if (result === null) mismatch();
      return { status: "judged", correct: result };
    },
  };
}

export function createOwnClassFillEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): OrderedTextEvaluatorRegistration {
  return {
    ...ownClassDeliveryEvaluatorRef,
    evaluate(input) {
      const scope = currentScope();
      if (scope?.lectureId !== undefined) mismatch();
      const { row, question } = frozenQuestionForEvaluation(db, scope, input, [
        "manual_only",
        "reference_self",
      ]);
      const source = orderedTextDeliveryScoringSourceSchema.safeParse(question);
      if (
        !source.success ||
        JSON.stringify(source.data.acceptedBlanks) !==
          JSON.stringify(input.acceptedBlanks)
      )
        mismatch();
      const result = gradeResponseRow(
        row.gradingPolicy,
        question,
        deliveryAnswerOf(row, input.value) ?? undefined,
      );
      if (result !== null) mismatch();
      return { status: "needsReview" };
    },
  };
}

export function createOwnClassTitledTextEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): TitledTextEvaluatorRegistration {
  return {
    ...ownClassDeliveryEvaluatorRef,
    evaluate(input) {
      const scope = currentScope();
      if (scope?.lectureId !== undefined) mismatch();
      const { row, question } = frozenQuestionForEvaluation(db, scope, input, [
        "manual_only",
        "reference_self",
      ]);
      if (!responseDeliveryScoringSourceSchema.safeParse(question).success)
        mismatch();
      const result = gradeResponseRow(
        row.gradingPolicy,
        question,
        deliveryAnswerOf(row, input.value) ?? undefined,
      );
      if (result !== null) mismatch();
      return { status: "needsReview" };
    },
  };
}
