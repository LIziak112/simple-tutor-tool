import type { QueryClient } from "@tanstack/react-query";
import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MarkRequest, MarkResponseData } from "@tutor/contract";
import {
  fetchPendingMarksApi,
  markResponseApi,
  type PendingMarkListParams,
} from "@/lib/api";

/** 队列筛选参数形态（界面层；透传自 lib/api） */
export type { PendingMarkListParams } from "@/lib/api";

/**
 * 批注与待批队列的 TanStack Query 封装（T3.2b，D3/D4）：
 * - usePendingMarks：队列按筛选参数分 key（无分页，D4 单教师规模一次取全量）；
 * - useMarkResponse：批注 mutation。成功后统一失效 D2 联动的各处缓存——
 *   数据页列表、作答详情、待批队列、作业名单（assignment detail）、课程组
 *   （含进度矩阵 progress 与课程详情）与学生端查询族（学生课程单元卡片等，
 *   同浏览器场景下的自然刷新；跨设备由学生端刷新页面重新拉取），
 *   让「已批改」状态与 scoreFinal 优先展示在各处自然更新。
 */

/** 待批队列 key（筛选参数对象进入 key） */
export const pendingMarksKey = (params: PendingMarkListParams) =>
  ["teacher", "pending-marks", params] as const;

/** 待批队列（D4；submittedAt 升序；三态由页面接 isPending/isError） */
export function usePendingMarks(params: PendingMarkListParams) {
  return useQuery({
    queryKey: pendingMarksKey(params),
    queryFn: () => fetchPendingMarksApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** 批注 mutation 的入参（D3：判定与评语两字段一次提交，值可为 null） */
export interface MarkMutationVariables extends MarkRequest {
  /** 批注定位的 responses.id */
  responseId: string;
}

/** 批注成功后失效 D2 联动的各处缓存（队列页与详情页内联批改共用） */
export function invalidateMarkCaches(queryClient: QueryClient): void {
  // 待批队列（批注后该项应离队 / 撤销后回队）
  void queryClient.invalidateQueries({
    queryKey: ["teacher", "pending-marks"],
  });
  // 数据页列表（teacherAttemptsKey 的前缀）
  void queryClient.invalidateQueries({ queryKey: ["teacher", "attempts"] });
  // 作答详情（判定区与顶部得分汇总即时刷新）
  void queryClient.invalidateQueries({
    queryKey: ["teacher", "attempt-detail"],
  });
  // 作业名单与统计（assignmentDetailKey / assignmentsKey 的共同前缀）
  void queryClient.invalidateQueries({ queryKey: ["teacher", "assignments"] });
  // 课程组：进度矩阵（progressKey）+ 课程详情 / 学生可见预览
  void queryClient.invalidateQueries({ queryKey: ["teacher", "courses"] });
  // 学生端查询族（作业状态徽章 / 课程单元卡片 / 结果视图；同浏览器时自然刷新）
  void queryClient.invalidateQueries({ queryKey: ["student"] });
}

/** 批注单题（POST /api/teacher/responses/:id/mark；成功后失效 D2 联动缓存） */
export function useMarkResponse(): UseMutationResult<
  MarkResponseData,
  Error,
  MarkMutationVariables
> {
  const queryClient = useQueryClient();
  return useMutation<MarkResponseData, Error, MarkMutationVariables>({
    mutationFn: ({ responseId, mark, comment }) =>
      markResponseApi(responseId, { mark, comment }),
    onSuccess: () => invalidateMarkCaches(queryClient),
  });
}
