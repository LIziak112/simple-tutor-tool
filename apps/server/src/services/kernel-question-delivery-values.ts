import {
  choiceStudentAnswerSchema,
  judgeBehavior,
  judgeStudentAnswerSchema,
  matchingBehavior,
  matchingDeliveryAnswerSchema,
  matchingDeliveryValueOf,
  matchingStudentAnswerSchema,
  orderingBehavior,
  questionEvidenceBindings,
  responseBehavior,
  responseStudentAnswerSchema,
  type StudentAnswer,
  studentAnswerSchema,
} from "@tutor/contract";
import type {
  QuestionAnswerRule,
  QuestionDeliveryDraftInput,
} from "learning-kernel";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertFrozenAnswerShape } from "./attempt-question-projection.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { snapshotOfRow } from "./snapshot.ts";

type Value = QuestionDeliveryDraftInput["value"];

// 内核已按作答形态解析原值；这里只把 unknown 收窄回该形态。
export const judgeValue = z.union([z.boolean(), z.string()]);
export const titledValue = z
  .strictObject({ body: z.string(), title: z.string().optional() })
  .transform(({ body, title }): { body: string; title?: string } =>
    title === undefined ? { body } : { body, title },
  );
export const blanksValue = z.array(z.string());

export const ownClassJudgeAnswerRuleRef = {
  id: "ownclass-judge-value",
  version: 1,
} as const;

export const ownClassJudgeAnswerRule = {
  ...ownClassJudgeAnswerRuleRef,
  responseType: "booleanOrString",
  isAnswered: (value: unknown) =>
    judgeBehavior.isAnswered({ kind: "judge", value: judgeValue.parse(value) }),
} satisfies QuestionAnswerRule;

export const ownClassResponseAnswerRuleRef = {
  id: "ownclass-response-body",
  version: 1,
} as const;

export const ownClassResponseAnswerRule = {
  ...ownClassResponseAnswerRuleRef,
  responseType: "textWithOptionalTitle",
  isAnswered: (value: unknown) =>
    responseBehavior.isAnswered({
      ...titledValue.parse(value),
      kind: "response",
    }),
} satisfies QuestionAnswerRule;

export const ownClassOrderingAnswerRuleRef = {
  id: "ownclass-ordering-sequence",
  version: 1,
} as const;

export const ownClassOrderingAnswerRule = {
  ...ownClassOrderingAnswerRuleRef,
  responseType: "orderedTextBlanks",
  isAnswered: (value: unknown) =>
    orderingBehavior.isAnswered({
      kind: "ordering",
      sequence: blanksValue.parse(value),
    }),
} satisfies QuestionAnswerRule;

export const ownClassMatchingAnswerRuleRef = {
  id: "ownclass-matching-pairs",
  version: 1,
} as const;

export const ownClassMatchingAnswerRule = {
  ...ownClassMatchingAnswerRuleRef,
  responseType: "orderedTextBlanks",
  isAnswered: (value: unknown) =>
    matchingBehavior.isAnswered(matchingDeliveryAnswerSchema.parse(value)),
} satisfies QuestionAnswerRule;

export function deliveryAnswerOf(
  row: ResponseRow,
  value: Readonly<Value> | null,
): StudentAnswer | null {
  if (value === null) return null;
  const question = snapshotOfRow(row);
  const kind = question && questionEvidenceBindings[question.type].answerKind;
  const outcome =
    kind === matchingStudentAnswerSchema.shape.kind.value
      ? matchingDeliveryAnswerSchema.safeParse(value)
      : typeof value === "object"
        ? Array.isArray(value)
          ? studentAnswerSchema.safeParse({
              kind,
              indexes: value,
              values: value,
              sequence: value,
              finalAnswer: value.length === 1 ? value[0] : undefined,
            })
          : responseStudentAnswerSchema.safeParse({ ...value, kind })
        : kind === judgeStudentAnswerSchema.shape.kind.value
          ? judgeStudentAnswerSchema.safeParse({ kind, value })
          : choiceStudentAnswerSchema.safeParse({
              kind,
              index: Number(value),
            });
  if (
    !outcome.success ||
    ("index" in outcome.data && String(outcome.data.index) !== value)
  )
    kernelAttemptUnavailable();
  return outcome.data;
}

export function deliveryValueOf(
  db: Db,
  row: ResponseRow,
  answer: StudentAnswer,
): Value {
  const question = snapshotOfRow(row);
  if (
    !question ||
    questionEvidenceBindings[question.type].answerKind !== answer.kind
  )
    return invalidDeliveryAnswer();
  if ("index" in answer) return String(answer.index);
  if ("indexes" in answer) return answer.indexes;
  if ("values" in answer) return answer.values;
  if ("sequence" in answer || "pairs" in answer) {
    assertFrozenAnswerShape(db, row, question, answer);
    return "pairs" in answer
      ? matchingDeliveryValueOf(answer.pairs)
      : answer.sequence;
  }
  if ("finalAnswer" in answer) return [answer.finalAnswer];
  if ("value" in answer) return answer.value;
  if ("body" in answer) {
    const { body, title } = answer;
    return title === undefined ? { body } : { body, title };
  }
  return invalidDeliveryAnswer();
}

export function invalidDeliveryAnswer(): never {
  throw new HttpError(
    400,
    "VALIDATION_ERROR",
    "答案与冻结的题目选项或形态不一致",
  );
}
