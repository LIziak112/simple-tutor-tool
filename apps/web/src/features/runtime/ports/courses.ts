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
export interface CoursesPorts {
  fetchTeacherCourses(archived: boolean): Promise<CourseListData>;
  fetchCourseDetail(id: string): Promise<CourseDetailData>;
  fetchCourseStudentView(
    courseId: string,
    studentId: string,
  ): Promise<CourseStudentViewData>;
  addCourseItemsApi(
    courseId: string,
    request: CourseItemsAddRequest,
  ): Promise<CourseItemsAddData>;
  reorderCourseItemsApi(
    courseId: string,
    request: CourseItemsReorderRequest,
  ): Promise<null>;
  updateCourseItemApi(
    id: string,
    request: CourseItemUpdateRequest,
  ): Promise<CourseDetailData["items"][number]>;
  deleteCourseItemApi(id: string): Promise<null>;
  addCourseMembersApi(
    courseId: string,
    request: CourseMembersRequest,
  ): Promise<null>;
  removeCourseMembersApi(
    courseId: string,
    request: CourseMembersRequest,
  ): Promise<null>;
}
