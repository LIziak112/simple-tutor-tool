import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeacherPracticeFeedbackSettingsUpdateRequest } from "@tutor/contract";
import {
  fetchPracticeFeedbackSettings,
  savePracticeFeedbackSettings,
} from "@/lib/api";

/**
 * 教师练习反馈默认策略的查询封装（M1b；设置页「教学」区数据源）：
 * - 查看：useQuery（null = 未配置，仅对新普通自由练习按「由学生选择」缺省）；
 * - 保存：useMutation 二选一覆盖；成功后失效重取（以服务端为准）。
 * query key 以 teacher 域开头，随角色缓存清理（account-query-cache）一起失效。
 */

/** 策略查询键（保存成功后失效重取） */
export const practiceFeedbackSettingsKey = [
  "teacher",
  "practice-feedback",
] as const;

/** 查看当前策略（null = 未配置） */
export function usePracticeFeedbackSettings() {
  return useQuery({
    queryKey: practiceFeedbackSettingsKey,
    queryFn: fetchPracticeFeedbackSettings,
    refetchOnWindowFocus: false,
  });
}

/** 保存策略（二选一覆盖；返回服务端确认值） */
export function useSavePracticeFeedbackSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: TeacherPracticeFeedbackSettingsUpdateRequest) =>
      savePracticeFeedbackSettings(request),
    onSuccess: (settings) => {
      queryClient.setQueryData(practiceFeedbackSettingsKey, settings);
      void queryClient.invalidateQueries({
        queryKey: practiceFeedbackSettingsKey,
      });
    },
  });
}
