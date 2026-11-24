import {
  type GradingPolicy,
  judgeScoringSourceSchema,
  matchingDeliveryScoringSourceSchema,
  multiChoiceScoringSourceSchema,
  orderedTextDeliveryScoringSourceSchema,
  orderingDeliveryScoringSourceSchema,
  responseDeliveryScoringSourceSchema,
  singleChoiceScoringSourceSchema,
} from "@tutor/contract";
import { gradeResponseRow } from "@tutor/grading";
import type {
  EvaluationInput,
  EvaluatorRegistration,
  VerdictResult,
} from "learning-kernel";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  buildAttemptQuestionWhere,
  requireOwnAttempt,
} from "./attempt-access.ts";
import {
  blanksValue,
  deliveryAnswerOf,
  judgeValue,
  titledValue,
} from "./kernel-question-delivery-values.ts";
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
  course?: { courseId: string; unitId: string };
  wrong?: true;
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
  input: EvaluationInput,
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
  const expectedSource = scope.course
    ? "course"
    : scope.lectureId
      ? "lesson"
      : scope.wrong
        ? "wrong"
        : "assignment";
  if (
    attempt.sourceType !== expectedSource ||
    attempt.abandonedAt !== null ||
    attempt.frozenAt === null
  )
    mismatch();
  if (scope.course) {
    if (
      attempt.courseId !== scope.course.courseId ||
      attempt.unitId !== scope.course.unitId
    )
      mismatch();
  } else if (scope.lectureId) {
    if (attempt.lectureId !== scope.lectureId) mismatch();
  } else if (scope.wrong) {
    if (
      attempt.assignmentId !== null ||
      attempt.courseId !== null ||
      attempt.unitId !== null ||
      attempt.lectureId !== null
    )
      mismatch();
  } else if (attempt.assignmentId !== scope.assignmentId) mismatch();
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

export const ownClassDeliveryEvaluatorRef = {
  id: "ownclass-question-delivery",
  version: 1,
} as const;

type Reference = Readonly<{ id: string; version: number }>;
type Scope = () => OwnClassChoiceEvaluationScope | undefined;
type Evaluate = (
  db: Db,
  currentScope: Scope,
  input: EvaluationInput,
) => VerdictResult;

// 内核按作答形态解析后的原值与本题私有评分键；形态不符一律视为评分来源变化。
const choiceKeySchema = z.strictObject({ acceptedChoice: z.string() });
const judgeKeySchema = z.strictObject({ acceptedResponse: z.boolean() });
const indexKeySchema = z.strictObject({
  acceptedIndexes: z.array(z.number().int().nonnegative()),
});
const blankKeySchema = z.strictObject({
  acceptedBlanks: z.array(z.array(z.string())),
});
const choiceValueSchema = z.string().nullable();
const judgeValueSchema = judgeValue.nullable();
const indexValueSchema = z.array(z.number().int().nonnegative()).nullable();
const blanksValueSchema = blanksValue.nullable();
const titledValueSchema = titledValue.nullable();

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const outcome = schema.safeParse(value);
  if (!outcome.success) mismatch();
  return outcome.data;
}

const evaluateChoice: Evaluate = (db, currentScope, input) => {
  const { row, question } = frozenQuestionForEvaluation(
    db,
    currentScope(),
    input,
  );
  const key = parsed(choiceKeySchema, input.key);
  const choice = parsed(choiceValueSchema, input.value);
  const source = singleChoiceScoringSourceSchema.safeParse(question);
  if (
    !source.success ||
    String(source.data.answers.index) !== key.acceptedChoice
  )
    mismatch();
  const index = choice === null ? undefined : Number(choice);
  if (
    index !== undefined &&
    (String(index) !== choice || !source.data.options[index])
  )
    mismatch();
  const verdict = gradeResponseRow(
    row.gradingPolicy,
    question,
    index === undefined ? undefined : { kind: "choice", index },
  );
  if (verdict === null) mismatch();
  return { status: "judged", correct: verdict };
};

const evaluateJudge: Evaluate = (db, currentScope, input) => {
  const { row, question } = frozenQuestionForEvaluation(
    db,
    currentScope(),
    input,
  );
  const key = parsed(judgeKeySchema, input.key);
  const value = parsed(judgeValueSchema, input.value);
  const source = judgeScoringSourceSchema.safeParse(question);
  if (!source.success || source.data.answers.value !== key.acceptedResponse)
    mismatch();
  const result = gradeResponseRow(
    row.gradingPolicy,
    question,
    value === null ? undefined : { kind: "judge", value },
  );
  return result === null
    ? { status: "needsReview" }
    : { status: "judged", correct: result };
};

const evaluateMulti: Evaluate = (db, currentScope, input) => {
  const { row, question } = frozenQuestionForEvaluation(
    db,
    currentScope(),
    input,
  );
  const key = parsed(indexKeySchema, input.key);
  const value = parsed(indexValueSchema, input.value);
  const source = multiChoiceScoringSourceSchema.safeParse(question);
  if (
    !source.success ||
    JSON.stringify(source.data.answers.indexes) !==
      JSON.stringify(key.acceptedIndexes) ||
    value?.some((index) => !source.data.options[index])
  )
    mismatch();
  const result = gradeResponseRow(
    row.gradingPolicy,
    question,
    value === null ? undefined : { kind: "multi", indexes: [...value] },
  );
  if (result === null) mismatch();
  return { status: "judged", correct: result };
};

const orderedTextEvaluationSourceSchema = orderedTextDeliveryScoringSourceSchema
  .or(orderingDeliveryScoringSourceSchema)
  .or(matchingDeliveryScoringSourceSchema);

const evaluateOrderedText: Evaluate = (db, currentScope, input) => {
  const scope = currentScope();
  if (scope?.lectureId !== undefined) mismatch();
  const { row, question } = frozenQuestionForEvaluation(db, scope, input, [
    "manual_only",
    "reference_self",
  ]);
  const key = parsed(blankKeySchema, input.key);
  const value = parsed(blanksValueSchema, input.value);
  const source = orderedTextEvaluationSourceSchema.safeParse(question);
  if (
    !source.success ||
    JSON.stringify(source.data.acceptedBlanks) !==
      JSON.stringify(key.acceptedBlanks)
  )
    mismatch();
  const result = gradeResponseRow(
    row.gradingPolicy,
    question,
    deliveryAnswerOf(row, value) ?? undefined,
  );
  if (result !== null) mismatch();
  return { status: "needsReview" };
};

const evaluateTitledText: Evaluate = (db, currentScope, input) => {
  const scope = currentScope();
  if (scope?.lectureId !== undefined) mismatch();
  const { row, question } = frozenQuestionForEvaluation(db, scope, input, [
    "manual_only",
    "reference_self",
  ]);
  const value = parsed(titledValueSchema, input.value);
  if (!responseDeliveryScoringSourceSchema.safeParse(question).success)
    mismatch();
  const result = gradeResponseRow(
    row.gradingPolicy,
    question,
    deliveryAnswerOf(row, value) ?? undefined,
  );
  if (result !== null) mismatch();
  return { status: "needsReview" };
};

/** 作答形态 → 宿主判分实现。逐题交付评估器按内核传入的形态分派。 */
const evaluatorsByResponseType: Readonly<Record<string, Evaluate>> = {
  choice: evaluateChoice,
  booleanOrString: evaluateJudge,
  optionIndexArray: evaluateMulti,
  orderedTextBlanks: evaluateOrderedText,
  textWithOptionalTitle: evaluateTitledText,
};

function registration(
  db: Db,
  currentScope: Scope,
  reference: Reference,
  responseTypes: readonly string[],
): EvaluatorRegistration {
  return {
    ...reference,
    responseTypes,
    evaluate(input) {
      const evaluate = responseTypes.includes(input.responseType)
        ? evaluatorsByResponseType[input.responseType]
        : undefined;
      if (!evaluate) mismatch();
      return evaluate(db, currentScope, input);
    },
  };
}

/** 仅在宿主设定评分范围后由内核待评任务调用。以宿主冻结行校验评分来源，将实际答案交给统一判分入口。 */
export function createOwnClassEvaluators(
  db: Db,
  currentScope: Scope,
): EvaluatorRegistration[] {
  return [
    registration(db, currentScope, ownClassChoiceEvaluatorRef, ["choice"]),
    registration(db, currentScope, ownClassJudgeEvaluatorRef, [
      "booleanOrString",
    ]),
    registration(
      db,
      currentScope,
      ownClassDeliveryEvaluatorRef,
      Object.keys(evaluatorsByResponseType),
    ),
  ];
}
