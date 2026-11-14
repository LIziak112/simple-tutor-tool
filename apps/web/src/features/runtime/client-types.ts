import type {
  AttemptSource,
  AttemptStatus,
  QuestionReviewKind,
  StudentRecordsQuery,
} from "@tutor/contract";
export interface HealthData {
  /** UTC ISO 字符串（§0.3 时间约定：传输与存储一律 UTC，界面再转 Asia/Shanghai） */
  time: string;
}
export interface GzipJsonMessages {
  network: string;
  unsupported: string;
  decompress: string;
  corrupt: string;
}
export type NoteRole = "student" | "teacher";
export interface LibraryListParams {
  folderId?: string | null | undefined;
  q?: string | undefined;
  deleted?: boolean | undefined;
}
export interface TeacherAttemptListParams {
  studentId?: string | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  unitId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  status?: AttemptStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}
export interface PendingMarkListParams {
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  studentId?: string | undefined;
}
export interface TeacherExportCsvParams {
  studentId?: string | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  from?: string | undefined;
  to?: string | undefined;
}
export type StudentRecordsParams = Omit<StudentRecordsQuery, "sort"> & {
  sort?: StudentRecordsQuery["sort"] | undefined;
};
export interface WrongQuestionsParams {
  knowledge?: string | undefined;
  includeResolved?: boolean | undefined;
}
export interface AnalyticsFetchParams {
  courseId?: string | undefined;
  days?: number | "all" | undefined;
  focusDays?: number | undefined;
}
export interface QuestionReviewParams {
  kind: QuestionReviewKind;
  courseId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}
export interface AiPolicySubjectRef {
  type: "student" | "assignment";
  id: string;
}

export type * from "@tutor/contract";
