import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityProfile } from "@tutor/contract";
import { fetchCapabilityProfile, saveCapabilityProfile } from "@/lib/api";

/**
 * 教师能力启用集的查询封装（T7.7，纯消费接口；设置页「辅助能力」区数据源）：
 * - 查看：useQuery（未配置 → 全启用回显）；
 * - 保存：useMutation 整体覆盖；成功后失效重取（勾选态以服务端为准）。
 * 生效语义：保存后学生重新打开页面生效（读时计算），本页不做推送提示。
 */

/** 启用集查询键（保存成功后失效重取） */
export const capabilityProfileKey = ["teacher", "capability-profile"] as const;

/** 查看当前启用集（未配置 → 全启用） */
export function useCapabilityProfile() {
  return useQuery({
    queryKey: capabilityProfileKey,
    queryFn: fetchCapabilityProfile,
    refetchOnWindowFocus: false,
  });
}

/** 保存启用集（整体覆盖；返回服务端确认值） */
export function useSaveCapabilityProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: CapabilityProfile) => saveCapabilityProfile(profile),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: capabilityProfileKey });
    },
  });
}
