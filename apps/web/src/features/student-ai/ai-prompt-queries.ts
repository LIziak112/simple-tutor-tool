import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiPromptSettingsPutRequest } from "@tutor/contract";
import {
  fetchStudentAiPromptsApi,
  fetchTeacherAiPromptsApi,
  saveStudentAiPromptsApi,
  saveTeacherAiPromptsApi,
} from "@/lib/api";

/**
 * AI 提示词槽位查询封装（hall-9533，出题助手/学情包/复习包「复制给 AI」
 * 提示词）：查看 useQuery（refetchOnWindowFocus 关闭，与设置页其他区一致
 * ——后台重取不得覆盖正在编辑的本地草稿）；保存 useMutation 成功后写回
 * 缓存并失效重取。教师/学生各一组端点与键。
 */

/** 教师 AI 提示词查询键（保存成功后失效重取） */
export const teacherAiPromptsKey = ["teacher", "ai-prompts"] as const;

/** 教师 AI 提示词草稿键（切分类不丢；登出时由设置页清除） */
export const teacherAiPromptsDraftKey = [
  "teacher",
  "ai-prompts-draft",
] as const;

/** 学生 AI 提示词查询键 */
export const studentAiPromptsKey = ["student", "ai-prompts"] as const;

/** 读教师 AI 提示词槽位 */
export function useTeacherAiPrompts() {
  return useQuery({
    queryKey: teacherAiPromptsKey,
    queryFn: fetchTeacherAiPromptsApi,
    refetchOnWindowFocus: false,
  });
}

/** 保存教师 AI 提示词槽位（409 AI_SETTINGS_STALE 由组件按 ApiError 分支） */
export function useSaveTeacherAiPrompts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AiPromptSettingsPutRequest) =>
      saveTeacherAiPromptsApi(request),
    onSuccess: (data) => {
      queryClient.setQueryData(teacherAiPromptsKey, data);
      void queryClient.invalidateQueries({ queryKey: teacherAiPromptsKey });
    },
  });
}

/** 读学生 AI 提示词槽位 */
export function useStudentAiPrompts() {
  return useQuery({
    queryKey: studentAiPromptsKey,
    queryFn: fetchStudentAiPromptsApi,
    refetchOnWindowFocus: false,
  });
}

/** 保存学生 AI 提示词槽位 */
export function useSaveStudentAiPrompts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AiPromptSettingsPutRequest) =>
      saveStudentAiPromptsApi(request),
    onSuccess: (data) => {
      queryClient.setQueryData(studentAiPromptsKey, data);
      void queryClient.invalidateQueries({ queryKey: studentAiPromptsKey });
    },
  });
}
