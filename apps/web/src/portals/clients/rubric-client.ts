import type {
  RubricFinalRequest,
  RubricReview,
  RubricSelfRequest,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createRubricClient(http: HttpRuntime) {
  const { api } = http;
  function saveRubricSelfApi(
    attemptId: string,
    questionId: string,
    request: RubricSelfRequest,
  ): Promise<RubricReview> {
    const args = { param: { id: attemptId, questionId }, json: request };
    return callApi(() =>
      api.api.student.attempts[":id"].questions[":questionId"].rubric.self.$put(
        args,
      ),
    );
  }
  function saveRubricFinalApi(
    attemptId: string,
    questionId: string,
    request: RubricFinalRequest,
  ): Promise<RubricReview> {
    const args = { param: { id: attemptId, questionId }, json: request };
    return callApi(() =>
      api.api.student.attempts[":id"].questions[
        ":questionId"
      ].rubric.final.$put(args),
    );
  }
  return { saveRubricSelfApi, saveRubricFinalApi };
}
