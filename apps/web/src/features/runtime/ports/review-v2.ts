import type {
  ReviewV2Create,
  ReviewV2Detail,
  ReviewV2RunPublic,
  reviewV2PreviewSchema,
} from "@tutor/contract";
import type { z } from "zod";
/** 传输端口直接复用契约；不复制复盘运行、任务或报告结构。 */
export interface ReviewV2Ports {
  listReviewRuns(
    attemptId: string,
    signal: AbortSignal,
  ): Promise<ReviewV2RunPublic[]>;
  previewReviewRun(
    attemptId: string,
    input: ReviewV2Create,
    signal: AbortSignal,
  ): Promise<z.infer<typeof reviewV2PreviewSchema>>;
  createReviewRun(
    attemptId: string,
    input: ReviewV2Create,
    signal: AbortSignal,
  ): Promise<ReviewV2RunPublic>;
  readReviewRun(runId: string, signal: AbortSignal): Promise<ReviewV2Detail>;
  cancelReviewRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<{ cancelled: true }>;
}
