import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewListData,
} from "@tutor/contract";
export interface ReviewQueuePorts {
  listStudentAiAttemptReviewQueueApi(
    archived: "exclude" | "only",
    attemptId?: string,
  ): Promise<AiAttemptReviewListData>;
  fetchStudentAiAttemptReviewDetailApi(
    taskId: string,
    signal: AbortSignal,
  ): Promise<AiAttemptReviewDetailData>;
}
