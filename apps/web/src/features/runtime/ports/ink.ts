import type { InkDoc, InkUploadData } from "@tutor/contract";
export interface InkPorts {
  fetchAttemptInkApi(
    attemptId: string,
    questionId: string,
  ): Promise<InkDoc | null>;
  putAttemptInkApi(
    attemptId: string,
    questionId: string,
    strokesGzip: Blob,
    snapshotPng: Blob,
    meta?: import("@tutor/contract").InkWriteMeta,
  ): Promise<InkUploadData>;
  studentInkPngUrl(attemptId: string, questionId: string): string;
  fetchTeacherInkStrokesApi(inkId: string): Promise<unknown>;
}
