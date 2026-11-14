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
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAnalyticsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchQuestionReviewApi(
    studentId: string,
    params: QuestionReviewParams,
  ): Promise<QuestionReviewData> {
    const query: Record<string, string> = { kind: params.kind };
    if (params.courseId !== undefined) query.courseId = params.courseId;
    if (params.from !== undefined) query.from = params.from;
    if (params.to !== undefined) query.to = params.to;
    query.limit = String(params.limit);
    if (params.cursor !== undefined) query.cursor = params.cursor;
    // hc 对带 param 的路由只推断出 param 入参，query 以独立变量传入（同 fetchAnalyticsStudentApi）
    const args = { param: { id: studentId }, query };
    return callApi(() =>
      api.api.teacher.students[":id"]["question-review"].$get(args),
    );
  }
  function analyticsQueryOf(
    params: AnalyticsFetchParams,
  ): Record<string, string> {
    const query: Record<string, string> = {};
    if (params.courseId !== undefined) query.courseId = params.courseId;
    if (params.days !== undefined) query.days = String(params.days);
    if (params.focusDays !== undefined)
      query.focusDays = String(params.focusDays);
    return query;
  }
  function fetchAnalyticsOverviewApi(
    params: AnalyticsFetchParams = {},
  ): Promise<AnalyticsOverviewData> {
    const query = analyticsQueryOf(params);
    return callApi(() =>
      api.api.teacher.analytics.overview.$get(
        Object.keys(query).length > 0 ? { query } : undefined,
      ),
    );
  }
  function fetchAnalyticsStudentApi(
    studentId: string,
    params: AnalyticsFetchParams = {},
  ): Promise<AnalyticsStudentData> {
    // hc 对带 param 的路由只推断出 param 入参，query 以独立变量传入（同 updateQuestion）
    const args = { param: { id: studentId }, query: analyticsQueryOf(params) };
    return callApi(() => api.api.teacher.analytics.student[":id"].$get(args));
  }
  function fetchAnalyticsQuestionsApi(
    params: AnalyticsFetchParams = {},
  ): Promise<AnalyticsQuestionsData> {
    const query = analyticsQueryOf(params);
    return callApi(() =>
      api.api.teacher.analytics.questions.$get(
        Object.keys(query).length > 0 ? { query } : undefined,
      ),
    );
  }
  return {
    fetchQuestionReviewApi,
    fetchAnalyticsOverviewApi,
    fetchAnalyticsStudentApi,
    fetchAnalyticsQuestionsApi,
  };
}
