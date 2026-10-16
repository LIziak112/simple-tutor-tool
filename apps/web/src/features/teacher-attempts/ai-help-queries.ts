import { useQuery } from "@tanstack/react-query";
import {
  fetchTeacherAiTaskDetailApi,
  fetchTeacherAttemptAiRecordsApi,
} from "@/lib/api";

/**
 * SAI-24 教师督学记录的 TanStack Query 封装（B13）：
 * - 按卷记录 key 含 attemptId——同页多张题卡共享一条缓存（React Query 去重），
 *   不自动刷新（督学留痕按需重取，抽屉失败重试走 refetch）；
 * - 任务详情按 taskId 缓存（抽屉逐任务按需展开：当时模板/对话/材料不随
 *   列表下发）；404（他域/不存在）不重试——重试只会拖慢缺失态出现。
 */

/** 按卷求助记录 key */
export const teacherAiRecordsKey = (attemptId: string) =>
  ["teacher", "attempt-ai-records", attemptId] as const;

/** 按卷求助记录（attemptId 为空（路由未就绪）不查） */
export function useTeacherAttemptAiRecords(attemptId: string | undefined) {
  return useQuery({
    queryKey: teacherAiRecordsKey(attemptId ?? "pending"),
    queryFn: () => fetchTeacherAttemptAiRecordsApi(attemptId ?? ""),
    enabled: attemptId !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** 教师域任务详情 key（抽屉展开时按需查询） */
export const teacherAiTaskDetailKey = (taskId: string) =>
  ["teacher", "ai-task-detail", taskId] as const;

/** 任务详情（taskId 为空不查；失败由抽屉呈现重试） */
export function useTeacherAiTaskDetail(taskId: string | undefined) {
  return useQuery({
    queryKey: teacherAiTaskDetailKey(taskId ?? "pending"),
    queryFn: () => fetchTeacherAiTaskDetailApi(taskId ?? ""),
    enabled: taskId !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
