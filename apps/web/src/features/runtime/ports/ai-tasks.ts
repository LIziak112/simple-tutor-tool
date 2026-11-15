import type {
  AiAttemptReviewAction,
  AiAttemptReviewCreateData,
  AiAttemptReviewCreateRequest,
  AiAttemptReviewListData,
  AiAttemptReviewPreviewData,
  AiAttemptReviewTaskPublic,
  AiBatchCreateData,
  AiBatchReviewCreateRequest,
  AiConnectionModelsData,
  AiConnectionModelsRequest,
  AiConnectionProbeData,
  AiConnectionProbeRequest,
  AiShareAccessStatusData,
  AiStatusData,
  AiTaskCreateRequest,
  AiTaskDetailData,
  AiTaskListData,
  AiTaskListQuery,
  AiTaskPublic,
} from "@tutor/contract";
export interface AiTasksPorts {
  fetchStudentAiConnectionModelsApi(
    request: AiConnectionModelsRequest,
  ): Promise<AiConnectionModelsData>;
  fetchStudentAiShareAccessStatusApi(
    taskId: string,
  ): Promise<AiShareAccessStatusData>;
  probeStudentAiConnectionApi(
    request: AiConnectionProbeRequest,
  ): Promise<AiConnectionProbeData>;
  fetchStudentAiStatusApi(
    attemptId: string,
    questionId: string,
  ): Promise<AiStatusData>;
  createStudentAiTaskApi(request: AiTaskCreateRequest): Promise<AiTaskPublic>;
  fetchStudentAiAttemptReviewPreviewApi(
    attemptId: string,
  ): Promise<AiAttemptReviewPreviewData>;
  listStudentAiAttemptReviewsApi(
    attemptId: string,
  ): Promise<AiAttemptReviewListData>;
  createStudentAiAttemptReviewApi(
    request: AiAttemptReviewCreateRequest,
  ): Promise<AiAttemptReviewCreateData>;
  postStudentAiAttemptReviewActionApi(
    taskId: string,
    action: AiAttemptReviewAction,
  ): Promise<AiAttemptReviewTaskPublic>;
  createStudentAiBatchReviewApi(
    request: AiBatchReviewCreateRequest,
  ): Promise<AiBatchCreateData>;
  listStudentAiTasksApi(
    query: Pick<AiTaskListQuery, "attemptId" | "questionId">,
  ): Promise<AiTaskListData>;
  fetchStudentAiTaskApi(taskId: string): Promise<AiTaskDetailData>;
  openStudentAiReplyApi(taskId: string): Promise<AiTaskPublic>;
}
