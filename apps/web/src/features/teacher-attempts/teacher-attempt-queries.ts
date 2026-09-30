import { useQuery } from "@tanstack/react-query";
import {
  fetchTeacherAttemptDetailApi,
  fetchTeacherAttemptsApi,
  fetchTeacherInkStrokesApi,
  type TeacherAttemptListParams,
} from "@/lib/api";

/**
 * 教师端作答数据的 TanStack Query 封装（T3.1，/t/data 与详情页共用）：
 * - 列表 key 含完整查询参数（筛选/分页任一变化都是独立缓存条目）；
 * - 详情按 attemptId 缓存（draft 只读视图，不自动刷新——D5「刷新才更新」）；
 * - 笔迹矢量按 inkId 缓存（T3.3 回放），不重试——404/损坏走快照降级，
 *   重试只会拖慢降级出现的时间。
 */

/** 数据页每页条数（与后端默认一致；D6 上限 200） */
export const ATTEMPT_PAGE_SIZE = 50;

/** 作答卡片列表 key（参数对象进入 key，结构共享保证引用稳定时命中缓存） */
export const teacherAttemptsKey = (params: TeacherAttemptListParams) =>
  ["teacher", "attempts", params] as const;

/** 作答卡片列表（D6：筛选 + 分页；三态由页面接 isPending/isError） */
export function useTeacherAttempts(params: TeacherAttemptListParams) {
  return useQuery({
    queryKey: teacherAttemptsKey(params),
    queryFn: () => fetchTeacherAttemptsApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** 作答详情 key */
export const teacherAttemptDetailKey = (attemptId: string) =>
  ["teacher", "attempt-detail", attemptId] as const;

/** 作答详情（D7 全字段；draft 亦可用。attemptId 为空（路由未就绪）不查） */
export function useTeacherAttemptDetail(attemptId: string | undefined) {
  return useQuery({
    queryKey: teacherAttemptDetailKey(attemptId ?? "pending"),
    queryFn: () => fetchTeacherAttemptDetailApi(attemptId ?? ""),
    enabled: attemptId !== undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 笔迹矢量数据 key（T3.3 回放；返回 unknown，由 parseInkReplayData 收窄） */
export const teacherInkReplayKey = (inkId: string) =>
  ["teacher", "ink-replay", inkId] as const;

/**
 * 教师端笔迹矢量数据（T3.3，GET /api/teacher/ink/:inkId.json.gz 解压后 JSON）。
 * 数据不重试：404（文件缺失）/损坏等失败情形按 D12 直接走 PNG 快照降级。
 */
export function useTeacherInkReplay(inkId: string | undefined) {
  return useQuery({
    queryKey: teacherInkReplayKey(inkId ?? "pending"),
    queryFn: () => fetchTeacherInkStrokesApi(inkId ?? ""),
    enabled: inkId !== undefined,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
