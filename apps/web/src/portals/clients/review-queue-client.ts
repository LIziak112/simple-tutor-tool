import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewListData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createReviewQueueClient(http: HttpRuntime) {
  const { fetch } = http;
  function listStudentAiAttemptReviewQueueApi(
    archived: "exclude" | "only",
    attemptId?: string,
  ): Promise<AiAttemptReviewListData> {
    const params = new URLSearchParams({ archived, limit: "50" });
    if (attemptId !== undefined) {
      params.set("attemptId", attemptId);
      params.set("includeOrigins", "1");
    }
    return callApi(() => fetch(`/api/student/ai/attempt-reviews?${params}`));
  }
  function fetchStudentAiAttemptReviewDetailApi(
    taskId: string,
    signal: AbortSignal,
  ): Promise<AiAttemptReviewDetailData> {
    return callApi(() =>
      fetch(`/api/student/ai/attempt-reviews/${taskId}`, {
        cache: "no-store",
        signal,
      }),
    );
  }
  return {
    listStudentAiAttemptReviewQueueApi,
    fetchStudentAiAttemptReviewDetailApi,
  };
}
