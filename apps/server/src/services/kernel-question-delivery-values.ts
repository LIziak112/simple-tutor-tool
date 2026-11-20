import {
  choiceStudentAnswerSchema,
  judgeBehavior,
  judgeStudentAnswerSchema,
  questionEvidenceBindings,
  responseBehavior,
  responseStudentAnswerSchema,
  type StudentAnswer,
  studentAnswerSchema,
} from "@tutor/contract";
import type {
  QuestionAnswerRuleRegistration,
  QuestionDeliveryDraftInput,
} from "learning-kernel";
import type { ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import { snapshotOfRow } from "./snapshot.ts";

type Value = QuestionDeliveryDraftInput["value"];

export const ownClassJudgeAnswerRuleRef = {
  id: "ownclass-judge-value",
  version: 1,
} as const;

export const ownClassJudgeAnswerRule = {
  ...ownClassJudgeAnswerRuleRef,
  response: "booleanOrString",
  isAnswered: (value) => judgeBehavior.isAnswered({ kind: "judge", value }),
} satisfies QuestionAnswerRuleRegistration;

export const ownClassResponseAnswerRuleRef = {
  id: "ownclass-response-body",
  version: 1,
} as const;

export const ownClassResponseAnswerRule = {
  ...ownClassResponseAnswerRuleRef,
  response: "textWithOptionalTitle",
  isAnswered: (value) =>
    responseBehavior.isAnswered({ ...value, kind: "response" }),
} satisfies QuestionAnswerRuleRegistration;

export function deliveryAnswerOf(
  row: ResponseRow,
  value: Readonly<Value> | null,
): StudentAnswer | null {
  if (value === null) return null;
  const question = snapshotOfRow(row);
  const kind = question && questionEvidenceBindings[question.type].answerKind;
  const outcome =
    typeof value === "object"
      ? Array.isArray(value)
        ? studentAnswerSchema.safeParse({
            kind,
            indexes: value,
            values: value,
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
