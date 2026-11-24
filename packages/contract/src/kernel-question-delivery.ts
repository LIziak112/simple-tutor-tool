import { z } from "zod";
import { attemptSubmitRequestSchema } from "./attempt-submission.ts";

export const kernelDeliverySourceSchema = z.enum([
  "whole",
  "question",
  "finish",
]);

export const kernelActivitySealSchema = z.object({
  receivedThroughSeq: z.int().nonnegative(),
  responses: z.array(
    z.object({
      responseId: z.string(),
      activeSec: z.int().nonnegative().nullable(),
      changeCount: z.int().nonnegative(),
    }),
  ),
});

export const kernelDeliveryOriginalSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("frozen"),
    documentId: z.uuid(),
    versionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("uncollected") }),
]);

const inkAttachmentSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const kernelFormalInkAnchorSchema = z.strictObject({
  questionId: z.string().min(1),
  ink: z
    .strictObject({
      inkId: z.uuid(),
      revision: z.int().positive(),
      strokeCount: z.int().nonnegative(),
      strokes: inkAttachmentSchema,
      png: inkAttachmentSchema,
    })
    .nullable(),
});

export type KernelFormalInkAnchor = z.infer<typeof kernelFormalInkAnchorSchema>;

const kernelPracticeSubmissionSchema = z.strictObject({
  mutationId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  workflowRevision: z.int().nonnegative(),
});

export type KernelPracticeSubmission = z.infer<
  typeof kernelPracticeSubmissionSchema
>;

export const kernelQuestionDeliveryIntentSchema = attemptSubmitRequestSchema
  .extend({
    source: kernelDeliverySourceSchema,
    selectedQuestionIds: z.array(z.string().min(1)).min(1),
    activitySeal: kernelActivitySealSchema,
    formalInk: z.array(kernelFormalInkAnchorSchema).min(1).optional(),
    practiceSubmission: kernelPracticeSubmissionSchema.optional(),
    questions: z
      .array(
        z.strictObject({
          questionId: z.string().min(1),
          questionVersion: z.int().positive(),
          revision: z.int().nonnegative(),
          original: kernelDeliveryOriginalSchema,
        }),
      )
      .min(1),
  })
  .refine(
    ({ selectedQuestionIds, source, practiceSubmission }) =>
      new Set(selectedQuestionIds).size === selectedQuestionIds.length &&
      (!practiceSubmission ||
        (source === "question" && selectedQuestionIds.length === 1)),
  );

export type KernelDeliverySource = z.infer<typeof kernelDeliverySourceSchema>;
export type KernelQuestionDeliveryIntent = z.infer<
  typeof kernelQuestionDeliveryIntentSchema
>;
