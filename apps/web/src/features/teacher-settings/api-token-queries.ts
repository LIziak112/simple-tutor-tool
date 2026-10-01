import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApiToken, resetApiToken } from "@/lib/api";

/**
 * API Token 的查询封装（T4.6，纯消费接口；设置页「AI 连接（API Token）」区数据源）：
 * - 查看：useQuery（D22：可随时查看；token 变更只发生在本页，重置后失效重取）；
 * - 生成 / 重置：useMutation（同一动作；重置需页面层二次确认——确认弹层与
 *   「已配置的客户端需更新」提示在 ApiTokenSection）。
 */

/** token 查询键（重置成功后失效重取） */
export const apiTokenKey = ["teacher", "api-token"] as const;

/** 查看当前 API Token（未生成为 null） */
export function useApiToken() {
  return useQuery({
    queryKey: apiTokenKey,
    queryFn: fetchApiToken,
    refetchOnWindowFocus: false,
  });
}

/** 生成 / 重置 API Token（返回新 token；旧 token 立即失效） */
export function useResetApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resetApiToken,
    onSuccess: () => {
      // 覆盖列值后立即失效重取（展示新 token）
      void queryClient.invalidateQueries({ queryKey: apiTokenKey });
    },
  });
}
