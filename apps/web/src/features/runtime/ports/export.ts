import type {
  LearningPackExportRequest,
  LearningPackPreviewData,
  ReviewPackPreviewData,
  ReviewPackRole,
} from "@tutor/contract";
export interface ExportPorts {
  previewLearningPackApi(
    request: LearningPackExportRequest,
  ): Promise<LearningPackPreviewData>;
  downloadLearningPackApi(request: LearningPackExportRequest): Promise<string>;
  fetchReviewPackPreviewApi(
    role: ReviewPackRole,
    attemptId: string,
    questionId: string,
  ): Promise<ReviewPackPreviewData>;
  downloadReviewPackApi(
    role: ReviewPackRole,
    attemptId: string,
    questionId: string,
  ): Promise<string>;
  downloadAttachmentApi(url: string, filename: string): Promise<void>;
}
