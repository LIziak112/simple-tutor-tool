import type {
  AssignmentCheckData,
  AssignmentCheckRequest,
  AssignmentCreateData,
  AssignmentCreateRequest,
  AssignmentDetailData,
  AssignmentUpdateRequest,
  TeacherAssignment,
  TeacherAssignmentListData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAssignmentsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchAssignmentsApi(
    courseId: string | undefined,
    includeDeleted: boolean,
  ): Promise<TeacherAssignmentListData> {
    const query: Record<string, string> = {};
    if (courseId !== undefined) query.courseId = courseId;
    if (includeDeleted) query.includeDeleted = "true";
    return callApi(() =>
      api.api.teacher.assignments.$get(
        Object.keys(query).length > 0 ? { query } : undefined,
      ),
    );
  }
  function fetchAssignmentDetailApi(id: string): Promise<AssignmentDetailData> {
    return callApi(() =>
      api.api.teacher.assignments[":id"].$get({ param: { id } }),
    );
  }
  function checkAssignmentApi(
    request: AssignmentCheckRequest,
  ): Promise<AssignmentCheckData> {
    return callApi(() =>
      api.api.teacher.assignments.check.$post({ json: request }),
    );
  }
  function createAssignmentApi(
    request: AssignmentCreateRequest,
  ): Promise<AssignmentCreateData> {
    return callApi(() => api.api.teacher.assignments.$post({ json: request }));
  }
  function updateAssignmentApi(
    id: string,
    request: AssignmentUpdateRequest,
  ): Promise<TeacherAssignment> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.assignments[":id"].$patch(args));
  }
  function deleteAssignmentApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.assignments[":id"].$delete({ param: { id } }),
    );
  }
  return {
    fetchAssignmentsApi,
    fetchAssignmentDetailApi,
    checkAssignmentApi,
    createAssignmentApi,
    updateAssignmentApi,
    deleteAssignmentApi,
  };
}
