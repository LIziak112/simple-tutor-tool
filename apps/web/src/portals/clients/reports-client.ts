import type { ReportDetail, ReportListData } from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createReportsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchStudentReports(studentId: string): Promise<ReportListData> {
    return callApi(() =>
      api.api.teacher.students[":id"].reports.$get({
        param: { id: studentId },
      }),
    );
  }
  function fetchReportDetail(reportId: string): Promise<ReportDetail> {
    return callApi(() =>
      api.api.teacher.reports[":id"].$get({ param: { id: reportId } }),
    );
  }
  return { fetchStudentReports, fetchReportDetail };
}
