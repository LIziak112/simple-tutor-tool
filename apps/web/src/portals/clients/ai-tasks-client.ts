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
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAiTasksClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function fetchStudentAiConnectionModelsApi(
    request: AiConnectionModelsRequest,
  ): Promise<AiConnectionModelsData> {
    return callApi(() =>
      api.api.student.ai.connections.models.$post({ json: request }),
    );
  }
  function fetchStudentAiShareAccessStatusApi(
    taskId: string,
  ): Promise<AiShareAccessStatusData> {
    return callApi(() =>
      api.api.student.ai.tasks[":id"].share.status.$get({
        param: { id: taskId },
      }),
    );
  }
  function probeStudentAiConnectionApi(
    request: AiConnectionProbeRequest,
  ): Promise<AiConnectionProbeData> {
    return callApi(() =>
      api.api.student.ai.connections.probe.$post({ json: request }),
    );
  }
  function fetchStudentAiStatusApi(
    attemptId: string,
    questionId: string,
  ): Promise<AiStatusData> {
    return callApi(() =>
      api.api.student.ai.status.$get({ query: { attemptId, questionId } }),
    );
  }
  function createStudentAiTaskApi(
    request: AiTaskCreateRequest,
  ): Promise<AiTaskPublic> {
    const args = { json: request };
    return callApi(() => api.api.student.ai.tasks.$post(args));
  }
  function fetchStudentAiAttemptReviewPreviewApi(
    attemptId: string,
  ): Promise<AiAttemptReviewPreviewData> {
    return callApi(() =>
      fetch(
        `/api/student/ai/attempt-reviews/preview?attemptId=${encodeURIComponent(attemptId)}`,
      ),
    );
  }
  function listStudentAiAttemptReviewsApi(
    attemptId: string,
  ): Promise<AiAttemptReviewListData> {
    return callApi(() =>
      fetch(
        `/api/student/ai/attempt-reviews?attemptId=${encodeURIComponent(attemptId)}&limit=50`,
      ),
    );
  }
  function createStudentAiAttemptReviewApi(
    request: AiAttemptReviewCreateRequest,
  ): Promise<AiAttemptReviewCreateData> {
    return callApi(() =>
      fetch("/api/student/ai/attempt-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
  function postStudentAiAttemptReviewActionApi(
    taskId: string,
    action: AiAttemptReviewAction,
  ): Promise<AiAttemptReviewTaskPublic> {
    return callApi(() =>
      fetch(`/api/student/ai/attempt-reviews/${taskId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }),
    );
  }
  function createStudentAiBatchReviewApi(
    request: AiBatchReviewCreateRequest,
  ): Promise<AiBatchCreateData> {
    return callApi(() =>
      fetch("/api/student/ai/batch-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
  function listStudentAiTasksApi(
    query: Pick<AiTaskListQuery, "attemptId" | "questionId">,
  ): Promise<AiTaskListData> {
    return callApi(() =>
      api.api.student.ai.tasks.$get({
        query: { attemptId: query.attemptId, questionId: query.questionId },
      }),
    );
  }
  function fetchStudentAiTaskApi(taskId: string): Promise<AiTaskDetailData> {
    return callApi(() =>
      api.api.student.ai.tasks[":id"].$get({ param: { id: taskId } }),
    );
  }
  function openStudentAiReplyApi(taskId: string): Promise<AiTaskPublic> {
    return callApi(() =>
      api.api.student.ai.tasks[":id"].opened.$post({ param: { id: taskId } }),
    );
  }
  return {
    fetchStudentAiConnectionModelsApi,
    fetchStudentAiShareAccessStatusApi,
    probeStudentAiConnectionApi,
    fetchStudentAiStatusApi,
    createStudentAiTaskApi,
    fetchStudentAiAttemptReviewPreviewApi,
    listStudentAiAttemptReviewsApi,
    createStudentAiAttemptReviewApi,
    postStudentAiAttemptReviewActionApi,
    createStudentAiBatchReviewApi,
    listStudentAiTasksApi,
    fetchStudentAiTaskApi,
    openStudentAiReplyApi,
  };
}
