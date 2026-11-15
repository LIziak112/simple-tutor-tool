import type {
  LessonLandingData,
  LessonQuestionSubmitData,
  LessonQuestionSubmitRequest,
  LessonStartData,
  PracticeQuestionFeedbackData,
  PracticeQuestionSubmitData,
  PracticeQuestionSubmitRequest,
  SelfReviewData,
  SelfReviewRequest,
} from "@tutor/contract";
export interface LessonPorts {
  fetchLessonLandingApi(
    lectureId: string,
    courseId?: string | undefined,
  ): Promise<LessonLandingData>;
  startLessonAttemptApi(
    lectureId: string,
    courseId?: string | undefined,
  ): Promise<LessonStartData>;
  submitLessonQuestionApi(
    attemptId: string,
    questionId: string,
    request: LessonQuestionSubmitRequest,
  ): Promise<LessonQuestionSubmitData>;
  submitPracticeQuestionApi(
    attemptId: string,
    questionId: string,
    request: PracticeQuestionSubmitRequest,
  ): Promise<PracticeQuestionSubmitData>;
  fetchPracticeQuestionFeedbackApi(
    attemptId: string,
    questionId: string,
  ): Promise<PracticeQuestionFeedbackData>;
  saveSelfReviewApi(
    attemptId: string,
    questionId: string,
    request: SelfReviewRequest,
  ): Promise<SelfReviewData>;
}
