import { useQuery } from "@tanstack/react-query";
import {
  fetchStudentRecordsApi,
  fetchStudentWrongQuestionsApi,
  type StudentRecordsParams,
  type WrongQuestionsParams,
} from "@/lib/api";

/**
 * 学生端「我的记录」与错题本数据查询（T3.5，D10/D11）：
 * - 记录列表 key 含完整查询参数（筛选/分页任一变化都是独立缓存条目）；
 * - 错题本无分页（单学生错题规模有限，与待批队列同口径）；
 * - 三态由页面接 isPending / isError 呈现（UI 约定）。
 */

/** 我的记录每页条数（与后端默认一致；D10 上限 200） */
export const STUDENT_RECORDS_PAGE_SIZE = 50;

/** 我的记录列表 key（参数对象进入 key，结构共享保证引用稳定时命中缓存） */
export const studentRecordsKey = (params: StudentRecordsParams) =>
  ["student", "records", params] as const;

/** 我的记录（D10：本人全部作答倒序索引 + 筛选 + 分页） */
export function useStudentRecords(params: StudentRecordsParams) {
  return useQuery({
    queryKey: studentRecordsKey(params),
    queryFn: () => fetchStudentRecordsApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** 错题本 key（knowledge/includeResolved 任一变化都是独立缓存条目） */
export const studentWrongQuestionsKey = (params: WrongQuestionsParams) =>
  ["student", "wrong-questions", params] as const;

/**
 * 错题本（D11：(学生, 题目) 跨来源聚合）。includeResolved=true 的全量形态
 * 另作考点 chips 选项的数据源（见错题本页），与主列表互不影响各自缓存。
 */
export function useStudentWrongQuestions(params: WrongQuestionsParams) {
  return useQuery({
    queryKey: studentWrongQuestionsKey(params),
    queryFn: () => fetchStudentWrongQuestionsApi(params),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
