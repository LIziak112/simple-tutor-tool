import { useQuery } from "@tanstack/react-query";
import {
  type AnalyticsFetchParams,
  fetchAnalyticsOverviewApi,
  fetchAnalyticsQuestionsApi,
  fetchAnalyticsStudentApi,
} from "@/lib/api";

/**
 * 学情三接口的 TanStack Query 封装（T4.2）：
 * - key 含完整查询参数（courseId/days/focusDays 任一变化都是独立缓存条目）；
 * - staleTime 15 秒（学情是查询式页面，§0.3 不做实时推送；窗口失焦不自动重取）；
 * - 学生画像按 id 缓存；id 为空（路由未就绪）不查。
 */

/** 学情总览 key（参数对象进入 key） */
export const analyticsOverviewKey = (params: AnalyticsFetchParams) =>
  ["teacher", "analytics", "overview", params] as const;

/** 学情总览（三态由页面接 isPending/isError） */
export function useAnalyticsOverview(params: AnalyticsFetchParams) {
  return useQuery({
    queryKey: analyticsOverviewKey(params),
    queryFn: () => fetchAnalyticsOverviewApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** 学生画像 key */
export const analyticsStudentKey = (
  studentId: string,
  params: AnalyticsFetchParams,
) => ["teacher", "analytics", "student", studentId, params] as const;

/** 学生画像（404 STUDENT_NOT_FOUND 走页面错误态；id 为空不查） */
export function useAnalyticsStudent(
  studentId: string | undefined,
  params: AnalyticsFetchParams,
) {
  return useQuery({
    queryKey: analyticsStudentKey(studentId ?? "pending", params),
    queryFn: () => fetchAnalyticsStudentApi(studentId ?? "", params),
    enabled: studentId !== undefined && studentId.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** 题目视角 key */
export const analyticsQuestionsKey = (params: AnalyticsFetchParams) =>
  ["teacher", "analytics", "questions", params] as const;

/** 题目视角（题目统计行按单元内题序稳定返回） */
export function useAnalyticsQuestions(params: AnalyticsFetchParams) {
  return useQuery({
    queryKey: analyticsQuestionsKey(params),
    queryFn: () => fetchAnalyticsQuestionsApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
