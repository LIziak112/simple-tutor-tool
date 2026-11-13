import { z } from "zod";
import {
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  answerRevisionSchema,
  attemptSubmitRevisionSchema,
  submitEvidenceDeclarationSchema,
} from "./attempt-submission.ts";

/** 每次确认交卷暂存一组批次。到期后可重新确认，作答草稿仍可使用。 */
export const ATTEMPT_BATCH_SUBMISSION_TTL_MS = 15 * 60_000;
export const ATTEMPT_BATCH_SUBMISSION_MAX_BYTES = 2 * 1024 * 1024;

export const attemptBatchSubmissionStartSchema = z.strictObject({
  batchCount: z.number().int().min(2),
});

export const attemptBatchSubmissionSessionSchema = z.object({
  submissionId: z.uuid(),
  expiresAt: z.iso.datetime(),
});

export const attemptBatchSubmissionBatchSchema = z.strictObject({
  batchIndex: z.number().int().nonnegative(),
  revisions: z
    .array(
      attemptSubmitRevisionSchema.extend({
        expectedAnswerRevision: answerRevisionSchema,
      }),
    )
    .min(1)
    .max(ATTEMPT_SUBMIT_MAX_QUESTIONS),
  evidence: z
    .array(submitEvidenceDeclarationSchema)
    .max(ATTEMPT_SUBMIT_MAX_QUESTIONS),
});

export const attemptBatchSubmissionFinishSchema = z.strictObject({
  confirmedSavedAnswers: z.literal(true).optional(),
});

export const attemptBatchSubmissionReceiptSchema = z.object({
  batchIndex: z.number().int().nonnegative(),
});

export type AttemptBatchSubmissionBatch = z.infer<
  typeof attemptBatchSubmissionBatchSchema
>;
