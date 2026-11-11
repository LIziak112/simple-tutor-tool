import type {
  RubricFinalRequest,
  RubricReview,
  RubricSelfRequest,
} from "@tutor/contract";
import { api, callApi } from "@/lib/api";

/**
 * 通用量表判卷（模块 3）学生侧 API：本人自评 / 本人裁定两条 PUT，响应均为本题
 * 最新量表视图（三份记录 + 在途 Agent 任务）。Agent 意见不走这里——由 Agent 经
 * MCP submit_rubric_opinion 写回；网页只发起任务（createStudentAiTaskApi +
 * purpose=rubric_opinion）并读投影。json 以独立变量传入的原因同 updateQuestion。
 */
export function saveRubricSelfApi(
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

export function saveRubricFinalApi(
  attemptId: string,
  questionId: string,
  request: RubricFinalRequest,
): Promise<RubricReview> {
  const args = { param: { id: attemptId, questionId }, json: request };
  return callApi(() =>
    api.api.student.attempts[":id"].questions[":questionId"].rubric.final.$put(
      args,
    ),
  );
}
