import type {
  StudentCreateData,
  StudentCreateRequest,
  StudentListData,
  StudentResetLinkData,
  StudentResetPasswordData,
  StudentSummary,
  StudentUpdateRequest,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createStudentsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchStudentsApi(
    includeArchived: boolean,
  ): Promise<StudentListData> {
    return callApi(() =>
      api.api.teacher.students.$get(
        includeArchived ? { query: { includeArchived: "true" } } : undefined,
      ),
    );
  }
  function createStudentApi(
    request: StudentCreateRequest,
  ): Promise<StudentCreateData> {
    return callApi(() => api.api.teacher.students.$post({ json: request }));
  }
  function updateStudentApi(
    id: string,
    request: StudentUpdateRequest,
  ): Promise<StudentSummary> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.students[":id"].$patch(args));
  }
  function resetStudentPasswordApi(
    id: string,
  ): Promise<StudentResetPasswordData> {
    return callApi(() =>
      // 路径段按实际路由名取（reset-password，连字符），hc 不做驼峰转换
      api.api.teacher.students[":id"]["reset-password"].$post({
        param: { id },
      }),
    );
  }
  function resetStudentLinkApi(id: string): Promise<StudentResetLinkData> {
    return callApi(() =>
      api.api.teacher.students[":id"]["reset-link"].$post({ param: { id } }),
    );
  }
  return {
    fetchStudentsApi,
    createStudentApi,
    updateStudentApi,
    resetStudentPasswordApi,
    resetStudentLinkApi,
  };
}
