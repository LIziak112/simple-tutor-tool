import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiAttemptReviewAction } from "@tutor/contract";
import { postStudentAiAttemptReviewActionApi } from "@/lib/api";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import { listStudentAiAttemptReviewQueueApi } from "./attempt-review-api";
import {
  attemptReviewListKey,
  attemptReviewPreviewKey,
  attemptReviewQueueKey,
} from "./attempt-review-entry";

/**
 * 「求助记录」里的整卷复盘任务查询与列表上的显式动作。列表只读公开视图——
 * 不取报告正文、不记已读。
 */

export function useAttemptReviewQueue(
  archived: "exclude" | "only",
  attemptId?: string,
) {
  return useQuery({
    queryKey: [...attemptReviewQueueKey, archived, attemptId],
    queryFn: () => listStudentAiAttemptReviewQueueApi(archived, attemptId),
    refetchOnWindowFocus: false,
  });
}

/** 列表上的取消 / 重试 / 归档：成功后列表、角标与对应结果页入口一起刷新 */
export function useAttemptReviewQueueAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      taskId: string;
      attemptId: string;
      action: Exclude<AiAttemptReviewAction, "open">;
    }) => postStudentAiAttemptReviewActionApi(input.taskId, input.action),
    onSuccess: (_task, input) => {
      for (const queryKey of [
        attemptReviewQueueKey,
        studentAiQueueSummaryKey,
        attemptReviewListKey(input.attemptId),
        attemptReviewPreviewKey(input.attemptId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
