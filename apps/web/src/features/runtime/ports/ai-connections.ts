import type {
  AiConnectionCreateData,
  AiConnectionCreateRequest,
  AiConnectionDeleteData,
  AiConnectionListData,
  AiConnectionPatchData,
  AiConnectionPatchRequest,
  AiConnectionTestData,
} from "@tutor/contract";
export interface AiConnectionsPorts {
  fetchStudentAiConnectionsApi(): Promise<AiConnectionListData>;
  createStudentAiConnectionApi(
    request: AiConnectionCreateRequest,
  ): Promise<AiConnectionCreateData>;
  patchStudentAiConnectionApi(
    connectionId: string,
    request: AiConnectionPatchRequest,
  ): Promise<AiConnectionPatchData>;
  deleteStudentAiConnectionApi(
    connectionId: string,
  ): Promise<AiConnectionDeleteData>;
  testStudentAiConnectionApi(
    connectionId: string,
  ): Promise<AiConnectionTestData>;
}
