import {
  type ReviewV2Create,
  reviewV2DetailSchema,
  reviewV2PreviewSchema,
  reviewV2RunPublicSchema,
} from "@tutor/contract";
import { z } from "zod";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createReviewV2Client(http: HttpRuntime) {
  const { fetch } = http;
  const path = (attemptId: string) =>
    `/api/student/ai/review-v2/attempts/${encodeURIComponent(attemptId)}`;
  async function listReviewRuns(attemptId: string, signal: AbortSignal) {
    return z
      .object({ runs: z.array(reviewV2RunPublicSchema) })
      .parse(
        await callApi(() =>
          fetch(path(attemptId), { cache: "no-store", signal }),
        ),
      ).runs;
  }
  async function previewReviewRun(
    attemptId: string,
    input: ReviewV2Create,
    signal: AbortSignal,
  ) {
    return reviewV2PreviewSchema.parse(
      await callApi(() =>
        fetch(`${path(attemptId)}/preview`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      ),
    );
  }
  async function createReviewRun(
    attemptId: string,
    input: ReviewV2Create,
    signal: AbortSignal,
  ) {
    return z.object({ run: reviewV2RunPublicSchema }).parse(
      await callApi(() =>
        fetch(path(attemptId), {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      ),
    ).run;
  }
  async function readReviewRun(runId: string, signal: AbortSignal) {
    return reviewV2DetailSchema.parse(
      await callApi(() =>
        fetch(`/api/student/ai/review-v2/runs/${encodeURIComponent(runId)}`, {
          cache: "no-store",
          signal,
        }),
      ),
    );
  }
  async function cancelReviewRun(runId: string, signal: AbortSignal) {
    return z.object({ cancelled: z.literal(true) }).parse(
      await callApi(() =>
        fetch(
          `/api/student/ai/review-v2/runs/${encodeURIComponent(runId)}/cancel`,
          {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        ),
      ),
    );
  }
  return {
    listReviewRuns,
    previewReviewRun,
    createReviewRun,
    readReviewRun,
    cancelReviewRun,
  };
}
