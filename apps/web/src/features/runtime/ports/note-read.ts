import type {
  NoteHeadData,
  NoteImageMeta,
  NoteImageUploadMeta,
} from "@tutor/contract";
import type { NoteRole } from "@/features/runtime/client-types";
export interface NoteReadPorts {
  fetchStudentNoteHeadsApi(
    attemptId: string,
    questionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<NoteHeadData[]>;
  fetchStudentNoteEvidenceApi(
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData>;
  fetchTeacherNoteEvidenceApi(
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData>;
  fetchStudentNoteDocumentApi(versionId: string): Promise<unknown>;
  fetchTeacherNoteDocumentApi(versionId: string): Promise<unknown>;
  studentNoteImagePngUrl(versionId: string, imageId: string): string;
  teacherNoteImagePngUrl(versionId: string, imageId: string): string;
  postNoteImageApi(
    role: NoteRole,
    versionId: string,
    png: Blob,
    meta: NoteImageUploadMeta,
  ): Promise<NoteImageMeta>;
}
