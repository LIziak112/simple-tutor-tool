import type {
  CorrectionCreateRequest,
  CorrectionSealRequest,
  NoteHeadData,
  NoteUploadMetaInput,
  NoteVersionReceipt,
  StudentNotebookData,
} from "@tutor/contract";
export interface NoteWritePorts {
  putNoteDocumentApi(
    attemptId: string,
    questionId: string,
    body: Blob,
    meta: NoteUploadMetaInput,
    signal?: AbortSignal,
  ): Promise<NoteVersionReceipt>;
  createCorrectionApi(
    attemptId: string,
    questionId: string,
    body: CorrectionCreateRequest,
  ): Promise<NoteHeadData>;
  sealCorrectionApi(
    attemptId: string,
    questionId: string,
    body: CorrectionSealRequest,
  ): Promise<NoteHeadData>;
  fetchStudentNotebookApi(questionId: string): Promise<StudentNotebookData>;
}
