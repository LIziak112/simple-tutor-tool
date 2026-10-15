import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StudentQuickButton,
  StudentQuickButtonsData,
  StudentQuickButtonsPutRequest,
} from "@tutor/contract";
import {
  fetchStudentQuickButtonsApi,
  saveStudentQuickButtonsApi,
} from "@/lib/api";

/**
 * SAI-08 学生快捷按钮查询封装（管理组件的数据源）。
 * 查看：useQuery（refetchOnWindowFocus 关闭，与设置页其他区一致——后台重取
 * 不得覆盖正在编辑的本地草稿）；保存：useMutation 成功后写回缓存并失效重取，
 * 组件用返回的 data 即时回显服务端确认值（整组规范形态：按 orderIndex 升序）。
 * 查询键挂在 ["student", …] 下：学生登出统一清 ["student"] 缓存时一并带走。
 */

/** 快捷按钮查询键（保存成功后失效重取） */
export const studentQuickButtonsKey = ["student", "ai-quick-buttons"] as const;

/** 快捷按钮草稿键（gcTime Infinity，离开页面/重挂不丢未保存编辑） */
export const studentQuickButtonsDraftKey = [
  "student",
  "ai-quick-buttons-draft",
] as const;

/** 读本人快捷按钮整组（服务端无配置时返回契约默认四项） */
export function useStudentQuickButtons() {
  return useQuery({
    queryKey: studentQuickButtonsKey,
    queryFn: fetchStudentQuickButtonsApi,
    refetchOnWindowFocus: false,
  });
}

/** 整组保存（409 AI_SETTINGS_STALE 等错误由组件按 ApiError 分支处理） */
export function useSaveStudentQuickButtons() {
  const queryClient = useQueryClient();
  return useMutation({
    // 包一层丢弃 react-query 传入的 mutation 上下文（不进 API 函数签名）
    mutationFn: (request: StudentQuickButtonsPutRequest) =>
      saveStudentQuickButtonsApi(request),
    onSuccess: (data) => {
      queryClient.setQueryData(studentQuickButtonsKey, data);
      void queryClient.invalidateQueries({ queryKey: studentQuickButtonsKey });
    },
  });
}

/** 两个按钮组是否逐项一致（含顺序；orderIndex 由数组位次派生后比较） */
export function quickButtonsEqual(
  a: readonly StudentQuickButton[],
  b: readonly StudentQuickButton[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((button, index) => {
    const other = b[index];
    if (other === undefined) return false;
    return (
      button.id === other.id &&
      button.name === other.name &&
      button.prompt === other.prompt &&
      button.enabled === other.enabled &&
      button.attachmentPref.annotation === other.attachmentPref.annotation &&
      button.attachmentPref.draft === other.attachmentPref.draft &&
      button.attachmentPref.formalInk === other.attachmentPref.formalInk
    );
  });
}

/** 数据形态便利类型（组件入参/断言复用） */
export type { StudentQuickButtonsData };
