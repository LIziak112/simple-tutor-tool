import type {
  StudentAssignmentListData,
  StudentCourseDetailData,
  StudentCourseListData,
  StudentLectureDetail,
  StudentLectureListData,
  StudentLoginRequest,
  StudentMeData,
} from "@tutor/contract";
export interface LearnerSessionPorts {
  loginStudentApi(request: StudentLoginRequest): Promise<StudentMeData>;
  fetchStudentMe(): Promise<StudentMeData>;
  logoutStudentApi(): Promise<null>;
  fetchStudentAssignmentsApi(): Promise<StudentAssignmentListData>;
  fetchStudentLecturesApi(): Promise<StudentLectureListData>;
  fetchStudentCoursesApi(): Promise<StudentCourseListData>;
  fetchStudentCourseApi(id: string): Promise<StudentCourseDetailData>;
  fetchStudentLectureApi(
    id: string,
    courseId?: string | undefined,
  ): Promise<StudentLectureDetail>;
}
