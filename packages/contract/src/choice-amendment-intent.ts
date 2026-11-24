import { z } from "zod";
import { questionSchema } from "./content.ts";
import { choiceStudentAnswerSchema, studentAnswerSchema } from "./grading.ts";

const choiceAmendmentScope = z.strictObject({
  stepAttemptId: z.uuid(),
  practiceVersion: z.int().positive(),
  questionId: z.string().min(1),
  questionVersion: z.int().positive(),
  baseRevision: z.int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  createdAt: z.iso.datetime(),
});

export const choiceAmendmentIntentSchema = z.discriminatedUnion("kind", [
  choiceAmendmentScope.extend({
    kind: z.literal("answer").default("answer"),
    answer: choiceStudentAnswerSchema,
    prior: choiceStudentAnswerSchema.nullable(),
  }),
  choiceAmendmentScope.extend({
    kind: z.literal("snapshot"),
    snapshot: questionSchema,
    prior: z.string().min(1),
  }),
  // 题组交付槽（G33）：任一题型的草稿修正与题面勘误，审计 kind 仍记 answer / snapshot。
  choiceAmendmentScope.extend({
    kind: z.literal("deliveryAnswer"),
    answer: studentAnswerSchema,
    prior: studentAnswerSchema.nullable(),
  }),
  choiceAmendmentScope.extend({
    kind: z.literal("deliverySnapshot"),
    snapshot: questionSchema,
    prior: z.string().min(1),
  }),
]);

export function auditKindOf(intent: ChoiceAmendmentIntent) {
  return intent.kind === "answer" || intent.kind === "deliveryAnswer"
    ? ("answer" as const)
    : ("snapshot" as const);
}

export type ChoiceAmendmentIntent = z.infer<typeof choiceAmendmentIntentSchema>;
