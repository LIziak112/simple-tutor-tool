import type { AiAttemptReviewListData } from "@tutor/contract";
import { callApi } from "@/lib/api";

/**
 * 账号范围的整卷复盘任务列表（GET /ai/attempt-reviews，不带 attemptId，取
 * 最近 50 条）：响应带作答级来源摘要 origins，供「求助记录」写明每条任务是
 * 哪份卷的哪一次作答。只含公开视图，不含报告正文。
 */
export function listStudentAiAttemptReviewQueueApi(
  archived: "exclude" | "only",
): Promise<AiAttemptReviewListData> {
  return callApi(() =>
    fetch(`/api/student/ai/attempt-reviews?archived=${archived}&limit=50`),
  );
}
