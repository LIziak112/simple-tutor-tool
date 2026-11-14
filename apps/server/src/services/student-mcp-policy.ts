import type { Db } from "../db/client.ts";
import { HttpError } from "../lib/http-error.ts";
import { sqliteAiPolicyConfigSource } from "./ai-companion/ai-policy-config-source.ts";
import { resolveAttemptQuestionAiPolicy } from "./ai-companion/teaching-policy-service.ts";

/** MCP 写入及反馈读取实时使用当前 AI 门，成功重放也不豁免。 */
export function requireStudentMcpQuestionPolicy(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
) {
  const policy = resolveAttemptQuestionAiPolicy(
    db,
    studentId,
    attemptId,
    questionId,
    sqliteAiPolicyConfigSource,
    { frozenOnly: true },
  );
  if (!policy.resolution.usable)
    throw new HttpError(
      403,
      "AI_POLICY_DISABLED",
      "当前教学模式下本题暂不能由AI读取或提交",
    );
  return policy;
}
