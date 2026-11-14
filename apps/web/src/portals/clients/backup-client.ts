import type {
  BackupRestoreResult,
  CourseCatalogCommand,
} from "@tutor/contract";
import { callApi, throwShellError } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createBackupClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function deleteReportApi(reportId: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.reports[":id"].$delete({ param: { id: reportId } }),
    );
  }
  async function downloadBackupApi(): Promise<string> {
    let res: Response;
    try {
      res = await fetch("/api/teacher/backup/download", { method: "GET" });
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      // 文件接口的错误仍是统一 JSON 壳
      await throwShellError(res);
    }
    const filename = deps().filenameFromDisposition(res, "tutor-backup.zip");
    deps().saveBlobAs(await res.blob(), filename);
    return filename;
  }
  function restoreBackupApi(
    zip: File,
    password: string,
  ): Promise<BackupRestoreResult> {
    const form = new FormData();
    form.append("zip", zip);
    form.append("password", password);
    return callApi(() =>
      fetch("/api/teacher/backup/restore", { method: "POST", body: form }),
    );
  }
  function manageCourseCatalogApi(
    courseId: string,
    request: CourseCatalogCommand,
  ): Promise<{ id: string | null }> {
    const args = { param: { id: courseId }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].catalog.$post(args));
  }
  function questionProcessStatusApi(
    attemptId: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    signal?: AbortSignal,
  ): Promise<import("@tutor/contract").QuestionProcessStatus | null> {
    return callApi(() =>
      fetch(
        "/api/student/attempts/" +
          encodeURIComponent(attemptId) +
          "/question-process",
        {
          method,
          ...(signal ? { signal } : {}),
        },
      ),
    );
  }
  function uploadQuestionProcessApi(
    attemptId: string,
    batch: import("@tutor/contract").QuestionProcessBatch,
    signal: AbortSignal,
  ): Promise<{ acceptedThrough: number }> {
    return callApi(() =>
      fetch(
        "/api/student/attempts/" +
          encodeURIComponent(attemptId) +
          "/question-process",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
          signal,
        },
      ),
    );
  }
  function fetchTeacherQuestionProcessApi(
    attemptId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<import("@tutor/contract").QuestionProcessRead> {
    return callApi(() =>
      fetch(
        "/api/teacher/attempts/" +
          encodeURIComponent(attemptId) +
          "/questions/" +
          encodeURIComponent(questionId) +
          "/process",
        { signal },
      ),
    );
  }
  return {
    deleteReportApi,
    downloadBackupApi,
    restoreBackupApi,
    manageCourseCatalogApi,
    questionProcessStatusApi,
    uploadQuestionProcessApi,
    fetchTeacherQuestionProcessApi,
  };
}
