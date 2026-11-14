import { z } from "zod";
import {
  attemptResultQuestionSchema,
  questionRevisionIdSchema,
  submitEvidenceDeclarationSchema,
} from "./attempt.ts";
import { attemptSettlementSchema } from "./attempt-session.ts";
import {
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  answerRevisionSchema,
} from "./attempt-submission.ts";

export const attemptPartialQuestionSchema = z.strictObject({
  questionId: z.string().min(1),
  questionRevisionId: questionRevisionIdSchema,
  expectedAnswerRevision: answerRevisionSchema,
  evidence: submitEvidenceDeclarationSchema,
});
export const attemptPartialRequestSchema = z
  .strictObject({
    workflowVersion: z.literal(1),
    workflowRevision: z.number().int().nonnegative(),
    mutationId: z.uuid(),
    questions: z
      .array(attemptPartialQuestionSchema)
      .max(ATTEMPT_SUBMIT_MAX_QUESTIONS),
  })
  .refine(
    (input) =>
      new Set(input.questions.map((q) => q.questionId)).size ===
      input.questions.length,
    "同一题不能重复选择",
  );
// 结果只含本批成员；不给全卷进度或批外题目留下隐式出口。
export const attemptSettlementResultSchema = z.strictObject({
  settlement: attemptSettlementSchema,
  questions: z.array(attemptResultQuestionSchema),
  answersReleased: z.boolean(),
  questionNos: z.record(z.string(), z.number().int().positive()),
});
export type AttemptPartialRequest = z.infer<typeof attemptPartialRequestSchema>;
export type AttemptSettlementResult = z.infer<
  typeof attemptSettlementResultSchema
>;
