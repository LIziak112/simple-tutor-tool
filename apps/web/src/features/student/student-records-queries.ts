import { useQuery } from "@tanstack/react-query";
import { fetchStudentRecordsApi, type StudentRecordsParams } from "@/lib/api";

/**
 * 学生端「我的记录」数据查询（T3.5，D10）：
 * - 列表 key 含完整查询参数（筛选/分页任一变化都是独立缓存条目）；
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
