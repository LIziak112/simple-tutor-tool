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
export interface ContentPorts {
  fetchQuestionDetail(id: string): Promise<QuestionDetail>;
  updateQuestion(
    id: string,
    request: QuestionUpdateRequest,
  ): Promise<QuestionUpdateData>;
  deleteQuestionApi(id: string): Promise<null>;
  fetchLectureDetail(id: string): Promise<LectureDetail>;
  updateLecture(
    id: string,
    request: LectureUpdateRequest,
  ): Promise<LectureUpdateData>;
  deleteLectureApi(id: string): Promise<null>;
  reorderContentApi(request: ReorderRequest): Promise<null>;
  createCourseApi(request: CourseCreateRequest): Promise<CourseData>;
  updateCourseApi(
    id: string,
    request: CourseUpdateRequest,
  ): Promise<CourseData>;
  deleteCourseApi(id: string): Promise<null>;
}
