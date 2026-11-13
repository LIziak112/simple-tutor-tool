import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewListData,
} from "@tutor/contract";
import { callApi } from "@/lib/api";

/**
 * 求助记录的整卷任务列表（账号或单次作答范围内最近 50 条）：响应带作答级来源
 * 摘要 origins，供「求助记录」写明每条任务是
 * 哪份卷的哪一次作答。只含公开视图，不含报告正文。
 */
export function listStudentAiAttemptReviewQueueApi(
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

/** 报告详情每次打开都由服务端重新校验，关闭阅读器时取消在途请求。 */
export function fetchStudentAiAttemptReviewDetailApi(
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
