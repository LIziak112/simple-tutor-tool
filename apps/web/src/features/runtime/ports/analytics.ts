import type {
  AnalyticsOverviewData,
  AnalyticsQuestionsData,
  AnalyticsStudentData,
  QuestionReviewData,
} from "@tutor/contract";
import type {
  AnalyticsFetchParams,
  QuestionReviewParams,
} from "@/features/runtime/client-types";
export interface AnalyticsPorts {
  fetchQuestionReviewApi(
    studentId: string,
    params: QuestionReviewParams,
  ): Promise<QuestionReviewData>;
  fetchAnalyticsOverviewApi(
    params?: AnalyticsFetchParams,
  ): Promise<AnalyticsOverviewData>;
  fetchAnalyticsStudentApi(
    studentId: string,
    params?: AnalyticsFetchParams,
  ): Promise<AnalyticsStudentData>;
  fetchAnalyticsQuestionsApi(
    params?: AnalyticsFetchParams,
  ): Promise<AnalyticsQuestionsData>;
}
