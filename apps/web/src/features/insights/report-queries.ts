import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteReportApi,
  fetchReportDetail,
  fetchStudentReports,
} from "@/lib/api";

/**
 * 学情报告的查询封装（T4.7 画像页报告区，D24）：
 * - 列表：useStudentReports（createdAt 倒序摘要行；staleTime 0——报告由 AI 经
 *   MCP 随时写入，画像页每次进入都取最新）；
 * - 详情：useReportDetail（markdown 正文按需取，仅展开的报告启用查询）；
 * - 删除：useDeleteReport（确认弹层后调用，成功失效列表重取）。
 */

/** 报告列表 key（学生维度） */
export const studentReportsKey = (studentId: string) =>
  ["teacher", "reports", studentId] as const;

/** 报告详情 key（报告维度；展开行按需启用） */
export const reportDetailKey = (reportId: string) =>
  ["teacher", "report", reportId] as const;

/** 学生报告列表（id 为空〔路由未就绪〕不查） */
export function useStudentReports(studentId: string | undefined) {
  return useQuery({
    queryKey: studentReportsKey(studentId ?? "pending"),
    queryFn: () => fetchStudentReports(studentId ?? ""),
    enabled: studentId !== undefined && studentId.length > 0,
    refetchOnWindowFocus: false,
  });
}

/** 单份报告详情（markdown 正文；enabled 由调用方按展开态控制） */
export function useReportDetail(
  reportId: string | null,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: reportDetailKey(reportId ?? "pending"),
    queryFn: () => fetchReportDetail(reportId ?? ""),
    enabled: options.enabled && reportId !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 删除报告（成功后失效该学生的报告列表） */
export function useDeleteReport(studentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) => deleteReportApi(reportId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentReportsKey(studentId),
      });
    },
  });
}
