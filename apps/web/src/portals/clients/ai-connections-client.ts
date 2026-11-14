import type {
  AiConnectionCreateData,
  AiConnectionCreateRequest,
  AiConnectionDeleteData,
  AiConnectionListData,
  AiConnectionPatchData,
  AiConnectionPatchRequest,
  AiConnectionTestData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAiConnectionsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchStudentAiConnectionsApi(): Promise<AiConnectionListData> {
    return callApi(() => api.api.student.ai.connections.$get());
  }
  function createStudentAiConnectionApi(
    request: AiConnectionCreateRequest,
  ): Promise<AiConnectionCreateData> {
    const args = { json: request };
    return callApi(() => api.api.student.ai.connections.$post(args));
  }
  function patchStudentAiConnectionApi(
    connectionId: string,
    request: AiConnectionPatchRequest,
  ): Promise<AiConnectionPatchData> {
    const args = { param: { id: connectionId }, json: request };
    return callApi(() => api.api.student.ai.connections[":id"].$patch(args));
  }
  function deleteStudentAiConnectionApi(
    connectionId: string,
  ): Promise<AiConnectionDeleteData> {
    return callApi(() =>
      api.api.student.ai.connections[":id"].$delete({
        param: { id: connectionId },
      }),
    );
  }
  function testStudentAiConnectionApi(
    connectionId: string,
  ): Promise<AiConnectionTestData> {
    return callApi(() =>
      api.api.student.ai.connections[":id"].test.$post({
        param: { id: connectionId },
      }),
    );
  }
  return {
    fetchStudentAiConnectionsApi,
    createStudentAiConnectionApi,
    patchStudentAiConnectionApi,
    deleteStudentAiConnectionApi,
    testStudentAiConnectionApi,
  };
}
