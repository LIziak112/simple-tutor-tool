import type {
  BackupRestoreResult,
  CourseCatalogCommand,
} from "@tutor/contract";
export interface BackupPorts {
  deleteReportApi(reportId: string): Promise<null>;
  downloadBackupApi(): Promise<string>;
  restoreBackupApi(zip: File, password: string): Promise<BackupRestoreResult>;
  manageCourseCatalogApi(
    courseId: string,
    request: CourseCatalogCommand,
  ): Promise<{
    id: string | null;
  }>;
  questionProcessStatusApi(
    attemptId: string,
    method?: "GET" | "POST" | "DELETE",
    signal?: AbortSignal,
  ): Promise<import("@tutor/contract").QuestionProcessStatus | null>;
  uploadQuestionProcessApi(
    attemptId: string,
    batch: import("@tutor/contract").QuestionProcessBatch,
    signal: AbortSignal,
  ): Promise<{
    acceptedThrough: number;
  }>;
  fetchTeacherQuestionProcessApi(
    attemptId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<import("@tutor/contract").QuestionProcessRead>;
}
