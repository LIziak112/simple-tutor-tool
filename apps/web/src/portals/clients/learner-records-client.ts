import type { StudentRecordsData, WrongQuestionsData } from "@tutor/contract";
import type {
  StudentRecordsParams,
  WrongQuestionsParams,
} from "@/features/runtime/client-types";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createLearnerRecordsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchStudentRecordsApi(
    params: StudentRecordsParams,
  ): Promise<StudentRecordsData> {
    const query: Record<string, string> = {};
    if (params.sort !== undefined) query.sort = params.sort;
    if (params.sourceType !== undefined) query.sourceType = params.sourceType;
    if (params.courseId !== undefined) query.courseId = params.courseId;
    if (params.assignmentId !== undefined) {
      query.assignmentId = params.assignmentId;
    }
    if (params.status !== undefined) query.status = params.status;
    if (params.from !== undefined) query.from = params.from;
    if (params.to !== undefined) query.to = params.to;
    query.limit = String(params.limit);
    query.offset = String(params.offset);
    return callApi(() => api.api.student.records.$get({ query }));
  }
  function fetchStudentWrongQuestionsApi(
    params: WrongQuestionsParams,
  ): Promise<WrongQuestionsData> {
    const query: Record<string, string> = {};
    if (params.knowledge !== undefined) query.knowledge = params.knowledge;
    if (params.includeResolved !== undefined) {
      query.includeResolved = String(params.includeResolved);
    }
    return callApi(() =>
      api.api.student["wrong-questions"].$get(
        Object.keys(query).length > 0 ? { query } : undefined,
      ),
    );
  }
  return { fetchStudentRecordsApi, fetchStudentWrongQuestionsApi };
}
