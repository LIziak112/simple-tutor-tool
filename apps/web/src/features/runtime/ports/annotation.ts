import type {
  AnnotationBaseImageMeta,
  AnnotationBaseImageReceipt,
  AnnotationBasePreviewData,
  AnnotationPhase,
  AnnotationReceipt,
  AnnotationSealData,
  AnnotationSurfaceLayout,
  AnnotationUploadMetaInput,
  AnnotationViewData,
} from "@tutor/contract";
export interface AnnotationPorts {
  postAnnotationBaseApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
    layout?: AnnotationSurfaceLayout,
    signal?: AbortSignal,
    resetVersion?: number,
  ): Promise<AnnotationBasePreviewData>;
  postAnnotationBaseImageApi(
    attemptId: string,
    questionId: string,
    png: Blob,
    meta: Omit<AnnotationBaseImageMeta, "phase"> & {
      phase?: AnnotationPhase;
    },
    signal?: AbortSignal,
  ): Promise<AnnotationBaseImageReceipt>;
  putAnnotationDocApi(
    attemptId: string,
    questionId: string,
    body: Blob,
    meta: AnnotationUploadMetaInput,
    signal?: AbortSignal,
  ): Promise<AnnotationReceipt>;
  fetchAnnotationViewApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationViewData>;
  sealAttemptAnnotationsApi(
    attemptId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationSealData>;
  fetchTeacherAnnotationViewApi(
    attemptId: string,
    questionId: string,
    phase?: AnnotationPhase,
  ): Promise<AnnotationViewData>;
  studentAnnotationBasePngUrl(attemptId: string, baseId: string): string;
  teacherAnnotationBasePngUrl(baseId: string): string;
}
