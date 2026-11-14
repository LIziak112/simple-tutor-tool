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
export interface TeacherRecordsPorts {
  fetchTeacherAttemptsApi(
    params: TeacherAttemptListParams,
  ): Promise<TeacherAttemptListData>;
  fetchTeacherAttemptDetailApi(
    attemptId: string,
  ): Promise<TeacherAttemptDetailData>;
  fetchTeacherAttemptReplayApi(
    attemptId: string,
  ): Promise<TeacherAttemptReplayData>;
  fetchPendingMarksApi(
    params: PendingMarkListParams,
  ): Promise<PendingMarkListData>;
  markResponseApi(
    responseId: string,
    request: MarkRequest,
  ): Promise<MarkResponseData>;
  downloadTeacherExportCsv(params: TeacherExportCsvParams): Promise<void>;
}
