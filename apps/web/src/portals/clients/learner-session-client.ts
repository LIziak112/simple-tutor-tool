import type {
  StudentAssignmentListData,
  StudentCourseDetailData,
  StudentCourseListData,
  StudentLectureDetail,
  StudentLectureListData,
  StudentLoginRequest,
  StudentMeData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createLearnerSessionClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function loginStudentApi(
    request: StudentLoginRequest,
  ): Promise<StudentMeData> {
    return callApi(() => api.api.public.student.login.$post({ json: request }));
  }
  function fetchStudentMe(): Promise<StudentMeData> {
    return callApi(() => api.api.student.me.$get());
  }
  function logoutStudentApi(): Promise<null> {
    return callApi(() => api.api.student.logout.$post());
  }
  function fetchStudentAssignmentsApi(): Promise<StudentAssignmentListData> {
    return callApi(() => api.api.student.assignments.$get());
  }
  function fetchStudentLecturesApi(): Promise<StudentLectureListData> {
    return callApi(() => api.api.student.lectures.$get());
  }
  function fetchStudentCoursesApi(): Promise<StudentCourseListData> {
    return callApi(() => api.api.student.courses.$get());
  }
  function fetchStudentCourseApi(id: string): Promise<StudentCourseDetailData> {
    return callApi(() =>
      api.api.student.courses[":id"].$get({ param: { id } }),
    );
  }
  function fetchStudentLectureApi(
    id: string,
    courseId?: string | undefined,
  ): Promise<StudentLectureDetail> {
    return callApi(() =>
      api.api.student.lectures[":id"].$get({
        param: { id },
        ...(courseId !== undefined ? { query: { courseId } } : {}),
      }),
    );
  }
  return {
    loginStudentApi,
    fetchStudentMe,
    logoutStudentApi,
    fetchStudentAssignmentsApi,
    fetchStudentLecturesApi,
    fetchStudentCoursesApi,
    fetchStudentCourseApi,
    fetchStudentLectureApi,
  };
}
