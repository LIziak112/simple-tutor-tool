import type {
  MarkRequest,
  MarkResponseData,
  PendingMarkListData,
  TeacherAttemptDetailData,
  TeacherAttemptListData,
  TeacherAttemptReplayData,
} from "@tutor/contract";
import type {
  PendingMarkListParams,
  TeacherAttemptListParams,
  TeacherExportCsvParams,
} from "@/features/runtime/client-types";
import { callApi, throwShellError } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createTeacherRecordsClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function fetchTeacherAttemptsApi(
    params: TeacherAttemptListParams,
  ): Promise<TeacherAttemptListData> {
    const query: Record<string, string> = {};
    if (params.studentId !== undefined) query.studentId = params.studentId;
    if (params.courseId !== undefined) query.courseId = params.courseId;
    if (params.assignmentId !== undefined) {
      query.assignmentId = params.assignmentId;
    }
    if (params.unitId !== undefined) query.unitId = params.unitId;
    if (params.sourceType !== undefined) query.sourceType = params.sourceType;
    if (params.status !== undefined) query.status = params.status;
    if (params.from !== undefined) query.from = params.from;
    if (params.to !== undefined) query.to = params.to;
    query.limit = String(params.limit);
    query.offset = String(params.offset);
    return callApi(() => api.api.teacher.attempts.$get({ query }));
  }
  function fetchTeacherAttemptDetailApi(
    attemptId: string,
  ): Promise<TeacherAttemptDetailData> {
    return callApi(() =>
      api.api.teacher.attempts[":id"].$get({ param: { id: attemptId } }),
    );
  }
  function fetchTeacherAttemptReplayApi(
    attemptId: string,
  ): Promise<TeacherAttemptReplayData> {
    return callApi(() =>
      api.api.teacher.attempts[":id"].replay.$get({ param: { id: attemptId } }),
    );
  }
  function fetchPendingMarksApi(
    params: PendingMarkListParams,
  ): Promise<PendingMarkListData> {
    const query: Record<string, string> = {};
    if (params.courseId !== undefined) query.courseId = params.courseId;
    if (params.assignmentId !== undefined) {
      query.assignmentId = params.assignmentId;
    }
    if (params.studentId !== undefined) query.studentId = params.studentId;
    return callApi(() =>
      api.api.teacher["pending-marks"].$get(
        Object.keys(query).length > 0 ? { query } : undefined,
      ),
    );
  }
  function markResponseApi(
    responseId: string,
    request: MarkRequest,
  ): Promise<MarkResponseData> {
    const args = { param: { id: responseId }, json: request };
    return callApi(() => api.api.teacher.responses[":id"].mark.$post(args));
  }
  async function downloadTeacherExportCsv(
    params: TeacherExportCsvParams,
  ): Promise<void> {
    const query = new URLSearchParams();
    if (params.studentId !== undefined)
      query.set("studentId", params.studentId);
    if (params.courseId !== undefined) query.set("courseId", params.courseId);
    if (params.assignmentId !== undefined) {
      query.set("assignmentId", params.assignmentId);
    }
    if (params.sourceType !== undefined) {
      query.set("sourceType", params.sourceType);
    }
    if (params.from !== undefined) query.set("from", params.from);
    if (params.to !== undefined) query.set("to", params.to);
    const qs = query.toString();
    let res: Response;
    try {
      res = await fetch(`/api/teacher/export/csv${qs ? `?${qs}` : ""}`);
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      // 文件接口的错误仍是统一 JSON 壳
      await throwShellError(res);
    }
    const filename = deps().filenameFromDisposition(res, "tutor-export.csv");
    deps().saveBlobAs(await res.blob(), filename);
  }
  return {
    fetchTeacherAttemptsApi,
    fetchTeacherAttemptDetailApi,
    fetchTeacherAttemptReplayApi,
    fetchPendingMarksApi,
    markResponseApi,
    downloadTeacherExportCsv,
  };
}
