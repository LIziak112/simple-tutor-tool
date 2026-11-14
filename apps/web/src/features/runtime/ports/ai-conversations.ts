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
export interface AiConversationsPorts {
  createStudentAiShareTicketApi(
    taskId: string,
    request?: {
      validHours?: number;
    },
  ): Promise<AiTaskShareData>;
  revokeStudentAiShareTicketsApi(taskId: string): Promise<{
    revokedCount: number;
  }>;
  followupStudentAiTaskApi(
    taskId: string,
    request: AiTaskFollowupRequest,
  ): Promise<AiTaskFollowupData>;
  uploadStudentAiTaskMaterialsApi(
    taskId: string,
    pages: readonly {
      kind: "annotation" | "draft" | "formal_ink";
      pageIndex: number;
      pixelWidth: number;
      pixelHeight: number;
      png: Blob;
    }[],
  ): Promise<AiMaterialUploadReceiptData>;
  fetchStudentAiQueueSummaryApi(): Promise<AiQueueSummaryData>;
  listStudentAiQueueApi(
    query: Pick<AiTaskListQuery, "archived" | "limit" | "cursor">,
  ): Promise<AiTaskListData>;
  studentAiTaskActionApi(
    taskId: string,
    action: "cancel" | "resume" | "retry" | "archive",
  ): Promise<AiTaskPublic>;
}
