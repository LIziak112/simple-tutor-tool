import type {
  CourseDetailData,
  CourseItemsAddData,
  CourseItemsAddRequest,
  CourseItemsReorderRequest,
  CourseItemUpdateRequest,
  CourseListData,
  CourseMembersRequest,
  CourseStudentViewData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createCoursesClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchTeacherCourses(archived: boolean): Promise<CourseListData> {
    return callApi(() =>
      api.api.teacher.courses.$get(
        archived ? { query: { archived: "true" } } : undefined,
      ),
    );
  }
  function fetchCourseDetail(id: string): Promise<CourseDetailData> {
    return callApi(() =>
      api.api.teacher.courses[":id"].$get({ param: { id } }),
    );
  }
  function fetchCourseStudentView(
    courseId: string,
    studentId: string,
  ): Promise<CourseStudentViewData> {
    // hc 对带 param 的路由只推断出 param 入参，query/json 以独立变量传入（同 updateQuestion）
    const args = { param: { id: courseId }, query: { studentId } };
    return callApi(() =>
      api.api.teacher.courses[":id"]["student-view"].$get(args),
    );
  }
  function addCourseItemsApi(
    courseId: string,
    request: CourseItemsAddRequest,
  ): Promise<CourseItemsAddData> {
    const args = { param: { id: courseId }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].items.$post(args));
  }
  function reorderCourseItemsApi(
    courseId: string,
    request: CourseItemsReorderRequest,
  ): Promise<null> {
    const args = { param: { id: courseId }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].items.order.$put(args));
  }
  function updateCourseItemApi(
    id: string,
    request: CourseItemUpdateRequest,
  ): Promise<CourseDetailData["items"][number]> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher["course-items"][":id"].$patch(args));
  }
  function deleteCourseItemApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher["course-items"][":id"].$delete({ param: { id } }),
    );
  }
  function addCourseMembersApi(
    courseId: string,
    request: CourseMembersRequest,
  ): Promise<null> {
    const args = { param: { id: courseId }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].members.$post(args));
  }
  function removeCourseMembersApi(
    courseId: string,
    request: CourseMembersRequest,
  ): Promise<null> {
    const args = { param: { id: courseId }, json: request };
    return callApi(() => api.api.teacher.courses[":id"].members.$delete(args));
  }
  return {
    fetchTeacherCourses,
    fetchCourseDetail,
    fetchCourseStudentView,
    addCourseItemsApi,
    reorderCourseItemsApi,
    updateCourseItemApi,
    deleteCourseItemApi,
    addCourseMembersApi,
    removeCourseMembersApi,
  };
}
