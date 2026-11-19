import { choiceStudentAnswerSchema } from "@tutor/contract";
import { z } from "zod";

export const choiceAmendmentIntentSchema = z.strictObject({
  stepAttemptId: z.uuid(),
  practiceVersion: z.int().positive(),
  questionId: z.string().min(1),
  questionVersion: z.int().positive(),
  baseRevision: z.int().nonnegative(),
  answer: choiceStudentAnswerSchema,
  prior: choiceStudentAnswerSchema.nullable(),
  reason: z.string().trim().min(1).max(1000),
  createdAt: z.iso.datetime(),
});

export type ChoiceAmendmentIntent = z.infer<typeof choiceAmendmentIntentSchema>;
