import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiPolicyOverrideData } from "@tutor/contract";
import {
  fetchAiPolicyOverrideApi,
  fetchTeacherAiSettingsApi,
  putAiPolicyOverrideApi,
  saveTeacherAiSettingsApi,
} from "@/lib/api";

/**
 * SAI-07 教学配置查询封装（教师设置区与学生/作业覆盖字段的数据源）。
 * 查看：useQuery（refetchOnWindowFocus 关闭，与设置页其他区一致——后台重取
 * 不得覆盖正在编辑的本地草稿）；保存：useMutation 成功后写回缓存并失效重取，
 * 组件用返回的 data 即时回显服务端确认值。
 */

/** 教师全局设置查询键（保存成功后失效重取） */
export const teacherAiSettingsKey = ["teacher", "ai-settings"] as const;

/** 教师全局设置草稿键（切分类/关弹层不丢；登出时由设置页清除） */
export const teacherAiSettingsDraftKey = [
  "teacher",
  "ai-settings-draft",
] as const;

/** 学生/作业覆盖查询键（按对象分 key） */
export const aiPolicyOverrideKey = (type: string, id: string) =>
  ["teacher", "ai-policy", type, id] as const;

/** 学生/作业覆盖草稿键（gcTime Infinity，弹层重开不丢未保存编辑） */
export const aiPolicyOverrideDraftKey = (type: string, id: string) =>
  ["teacher", "ai-policy-draft", type, id] as const;

/** 读教师全局 AI 设置 */
export function useTeacherAiSettings() {
  return useQuery({
    queryKey: teacherAiSettingsKey,
    queryFn: fetchTeacherAiSettingsApi,
    refetchOnWindowFocus: false,
  });
}

/** 保存教师全局 AI 设置（409 AI_SETTINGS_STALE 等错误由组件按 ApiError 分支） */
export function useSaveTeacherAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    // 包一层丢弃 react-query 传入的 mutation 上下文（不进 API 函数签名）
    mutationFn: (request: Parameters<typeof saveTeacherAiSettingsApi>[0]) =>
      saveTeacherAiSettingsApi(request),
    onSuccess: (data) => {
      queryClient.setQueryData(teacherAiSettingsKey, data);
      void queryClient.invalidateQueries({ queryKey: teacherAiSettingsKey });
    },
  });
}

/** 读学生/作业的 AI 策略覆盖（含有效裁决预览） */
export function useAiPolicyOverride(
  subject: { type: "student" | "assignment"; id: string } | null,
) {
  return useQuery({
    queryKey: aiPolicyOverrideKey(
      subject?.type ?? "pending",
      subject?.id ?? "",
    ),
    queryFn: () => {
      if (subject === null) throw new Error("缺少覆盖对象");
      return fetchAiPolicyOverrideApi(subject);
    },
    enabled: subject !== null,
    refetchOnWindowFocus: false,
  });
}

/** 保存学生/作业的 AI 策略覆盖（成功后写回缓存 + 失效重取） */
export function usePutAiPolicyOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      subject: { type: "student" | "assignment"; id: string };
      mode: AiPolicyOverrideData["mode"];
    }) =>
      // 包一层丢弃 react-query 的 mutation 上下文（同 useSaveTeacherAiSettings）
      putAiPolicyOverrideApi(input.subject, input.mode),
    onSuccess: (data, { subject }) => {
      queryClient.setQueryData(
        aiPolicyOverrideKey(subject.type, subject.id),
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: aiPolicyOverrideKey(subject.type, subject.id),
      });
    },
  });
}
