import { z } from "zod";
import { questionSchema } from "./content.ts";
import { choiceStudentAnswerSchema } from "./grading.ts";

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
]);

export type ChoiceAmendmentIntent = z.infer<typeof choiceAmendmentIntentSchema>;
