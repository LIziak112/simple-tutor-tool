import type {
  CourseCreateRequest,
  CourseData,
  CourseUpdateRequest,
  LectureDetail,
  LectureUpdateData,
  LectureUpdateRequest,
  QuestionDetail,
  QuestionUpdateData,
  QuestionUpdateRequest,
  ReorderRequest,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createContentClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchQuestionDetail(id: string): Promise<QuestionDetail> {
    return callApi(() =>
      api.api.teacher.questions[":id"].$get({ param: { id } }),
    );
  }
  function updateQuestion(
    id: string,
    request: QuestionUpdateRequest,
  ): Promise<QuestionUpdateData> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.questions[":id"].$put(args));
  }
  function deleteQuestionApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.questions[":id"].$delete({ param: { id } }),
    );
  }
  function fetchLectureDetail(id: string): Promise<LectureDetail> {
    return callApi(() =>
      api.api.teacher.lectures[":id"].$get({ param: { id } }),
    );
  }
  function updateLecture(
    id: string,
    request: LectureUpdateRequest,
  ): Promise<LectureUpdateData> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.lectures[":id"].$put(args));
  }
  function deleteLectureApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.lectures[":id"].$delete({ param: { id } }),
    );
  }
  function reorderContentApi(request: ReorderRequest): Promise<null> {
    return callApi(() => api.api.teacher.reorder.$post({ json: request }));
  }
  function createCourseApi(request: CourseCreateRequest): Promise<CourseData> {
    return callApi(() => api.api.teacher.courses.$post({ json: request }));
  }
  function updateCourseApi(
    id: string,
    request: CourseUpdateRequest,
  ): Promise<CourseData> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].$patch(args));
  }
  function deleteCourseApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.courses[":id"].$delete({ param: { id } }),
    );
  }
  return {
    fetchQuestionDetail,
    updateQuestion,
    deleteQuestionApi,
    fetchLectureDetail,
    updateLecture,
    deleteLectureApi,
    reorderContentApi,
    createCourseApi,
    updateCourseApi,
    deleteCourseApi,
  };
}
