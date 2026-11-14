import type { ReportDetail, ReportListData } from "@tutor/contract";
export interface ReportsPorts {
  fetchStudentReports(studentId: string): Promise<ReportListData>;
  fetchReportDetail(reportId: string): Promise<ReportDetail>;
}
