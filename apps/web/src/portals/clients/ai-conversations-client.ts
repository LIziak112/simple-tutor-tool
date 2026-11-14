import type {
  AiMaterialUploadReceiptData,
  AiQueueSummaryData,
  AiTaskFollowupData,
  AiTaskFollowupRequest,
  AiTaskListData,
  AiTaskListQuery,
  AiTaskPublic,
  AiTaskShareData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAiConversationsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function createStudentAiShareTicketApi(
    taskId: string,
    request: { validHours?: number } = {},
  ): Promise<AiTaskShareData> {
    return callApi(() =>
      fetch(`/api/student/ai/tasks/${encodeURIComponent(taskId)}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
  function revokeStudentAiShareTicketsApi(
    taskId: string,
  ): Promise<{ revokedCount: number }> {
    return callApi(() =>
      fetch(`/api/student/ai/tasks/${encodeURIComponent(taskId)}/share`, {
        method: "DELETE",
      }),
    );
  }
  function followupStudentAiTaskApi(
    taskId: string,
    request: AiTaskFollowupRequest,
  ): Promise<AiTaskFollowupData> {
    return callApi(() =>
      fetch(`/api/student/ai/tasks/${encodeURIComponent(taskId)}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
  function uploadStudentAiTaskMaterialsApi(
    taskId: string,
    pages: readonly {
      kind: "annotation" | "draft" | "formal_ink";
      pageIndex: number;
      pixelWidth: number;
      pixelHeight: number;
      png: Blob;
    }[],
  ): Promise<AiMaterialUploadReceiptData> {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify(
        pages.map((page) => ({
          kind: page.kind,
          pageIndex: page.pageIndex,
          pixelWidth: page.pixelWidth,
          pixelHeight: page.pixelHeight,
        })),
      ),
    );
    pages.forEach((page, index) => {
      form.append(`page-${index}`, page.png, `page-${index}.png`);
    });
    return callApi(() =>
      fetch(`/api/student/ai/tasks/${encodeURIComponent(taskId)}/materials`, {
        method: "POST",
        body: form,
      }),
    );
  }
  function fetchStudentAiQueueSummaryApi(): Promise<AiQueueSummaryData> {
    return callApi(() => api.api.student.ai["queue-summary"].$get());
  }
  function listStudentAiQueueApi(
    query: Pick<AiTaskListQuery, "archived" | "limit" | "cursor">,
  ): Promise<AiTaskListData> {
    return callApi(() =>
      api.api.student.ai.tasks.$get({
        query: {
          ...(query.archived !== undefined ? { archived: query.archived } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        },
      }),
    );
  }
  function studentAiTaskActionApi(
    taskId: string,
    action: "cancel" | "resume" | "retry" | "archive",
  ): Promise<AiTaskPublic> {
    return callApi(() =>
      fetch(`/api/student/ai/tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: "POST",
      }),
    );
  }
  return {
    createStudentAiShareTicketApi,
    revokeStudentAiShareTicketsApi,
    followupStudentAiTaskApi,
    uploadStudentAiTaskMaterialsApi,
    fetchStudentAiQueueSummaryApi,
    listStudentAiQueueApi,
    studentAiTaskActionApi,
  };
}
