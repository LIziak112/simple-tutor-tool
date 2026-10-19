import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiConnectionCreateData,
  AiConnectionCreateRequest,
  AiConnectionListData,
  AiConnectionModelsRequest,
  AiConnectionPatchRequest,
  AiConnectionProbeRequest,
} from "@tutor/contract";
import {
  createStudentAiConnectionApi,
  deleteStudentAiConnectionApi,
  fetchStudentAiConnectionModelsApi,
  fetchStudentAiConnectionsApi,
  patchStudentAiConnectionApi,
  probeStudentAiConnectionApi,
  testStudentAiConnectionApi,
} from "@/lib/api";

/**
 * SAI-18 学生 AI 连接查询封装(/s/settings/ai 页数据源,SAI-16 五端点)。
 * 查看:useQuery(refetchOnWindowFocus 关闭——后台重取不得覆盖正在编辑的
 * 表单草稿,组件按 draft ?? baseline 合并)。写操作 useMutation 成功后统一
 * 失效重取(创建/更新返回的公开视图直接写回缓存,列表与详情同键同步)。
 * 查询键挂在 ["student", …] 下:学生登出 removeQueries(["student"]) 时
 * 换账号缓存立即隔离(与快捷按钮同款纪律)。
 */

/** 连接列表查询键(所有写操作成功后失效重取) */
export const studentAiConnectionsKey = ["student", "ai-connections"] as const;

/** 连接表单草稿键(gcTime Infinity,切页/卸载重挂不丢未保存编辑) */
export const studentAiConnectionDraftKey = [
  "student",
  "ai-connection-draft",
] as const;

/** 读本人 active 连接列表(未配置 → 空列表) */
export function useStudentAiConnections() {
  return useQuery({
    queryKey: studentAiConnectionsKey,
    queryFn: fetchStudentAiConnectionsApi,
    refetchOnWindowFocus: false,
  });
}

/** 写操作成功后统一收口:公开视图写回缓存 + 失效重取保持列表新鲜 */
function useInvalidateConnections() {
  const queryClient = useQueryClient();
  return (data: AiConnectionCreateData) => {
    queryClient.setQueryData<AiConnectionListData>(
      studentAiConnectionsKey,
      (prev) => {
        // 列表缓存未命中(如首进页面直接保存)时不强行拼装,留给失效重取
        if (prev === undefined) return undefined;
        const others = prev.connections
          .filter((item) => item.id !== data.connection.id)
          .map((item) =>
            data.connection.isDefault ? { ...item, isDefault: false } : item,
          );
        return { connections: [...others, data.connection] };
      },
    );
    void queryClient.invalidateQueries({ queryKey: studentAiConnectionsKey });
    void queryClient.invalidateQueries({ queryKey: ["student", "ai-status"] });
  };
}

/** 创建连接(错误由组件按 ApiError code 分支展示,输入不自动清空) */
export function useCreateStudentAiConnection() {
  const apply = useInvalidateConnections();
  return useMutation({
    mutationFn: (request: AiConnectionCreateRequest) =>
      createStudentAiConnectionApi(request),
    onSuccess: apply,
  });
}

/** 更新连接(inapp 不传 apiKey = 保持原 Key;mcp resetToken 见组件确认) */
export function usePatchStudentAiConnection() {
  const apply = useInvalidateConnections();
  return useMutation({
    mutationFn: (input: { id: string; request: AiConnectionPatchRequest }) =>
      patchStudentAiConnectionApi(input.id, input.request),
    onSuccess: apply,
  });
}

/** 删除连接(软删;成功后失效重取,列表即刻回到服务器真值) */
export function useDeleteStudentAiConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      deleteStudentAiConnectionApi(connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studentAiConnectionsKey });
      void queryClient.invalidateQueries({
        queryKey: ["student", "ai-status"],
      });
    },
  });
}

/**
 * 测试连接(inapp 真实探针;结果由组件就地展示,列表经失效重取刷新
 * verifyStatus 徽章——不在 mutation 里改写缓存,避免探针失败时本地覆盖)。
 */
export function useTestStudentAiConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      testStudentAiConnectionApi(connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studentAiConnectionsKey });
    },
  });
}

/** 诊断变量含短期凭据，组件卸载后立即回收，不保留诊断缓存。 */
export function useStudentAiConnectionModels() {
  return useMutation({
    mutationFn: (request: AiConnectionModelsRequest) =>
      fetchStudentAiConnectionModelsApi(request),
    gcTime: 0,
  });
}

export function useProbeStudentAiConnection() {
  return useMutation({
    mutationFn: (request: AiConnectionProbeRequest) =>
      probeStudentAiConnectionApi(request),
    gcTime: 0,
  });
}
