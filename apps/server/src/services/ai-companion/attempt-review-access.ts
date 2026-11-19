import type { Db } from "../../db/client.ts";
import type { Attempt, ResponseRow } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { frozenRowsInDisplayOrder } from "../attempt-rows.ts";
import { readKernelConfirmationFacts } from "../kernel-assignment-confirmation.ts";
import { isKernelAttempt } from "../kernel-assignment-routing.ts";
import { kernelAttemptUnavailable } from "../kernel-assignment-runtime.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import { attemptAnswersReleased } from "./student-ai-batch.ts";
import {
  type AiPolicyConfigSource,
  requireStudentAiAttempt,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

export function requireAttemptReviewAccess(
  db: Db,
  input: { studentId: string; attemptId: string },
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
) {
  const { attempt } = requireStudentAiAttempt(
    db,
    input.studentId,
    input.attemptId,
  );
  if (attempt.status === "draft") {
    throw new HttpError(
      409,
      "AI_ATTEMPT_REVIEW_NOT_SUBMITTED",
      "这份作答还未交卷，交卷后才能发起整体复盘",
    );
  }
  const released = attemptAnswersReleased(db, attempt);
  if (!released) {
    throw new HttpError(
      409,
      "AI_ATTEMPT_REVIEW_NOT_RELEASED",
      "这份作业的答案未公布，公布后才能发起整体复盘",
    );
  }
  // 题序 = 学生结果视图的展示序（单源 frozenRowsInDisplayOrder：建卷即冻结
  // 的卷按 rowid 建卷序，存量卷/懒冻结卷按当前题库序回退——直接查表自然序
  // 会走 (attempt_id, question_id) 唯一索引返回 UUID 序，与学生卷面错位，
  // 证据题号将指到错误的题）
  const rows = frozenRowsInDisplayOrder(db, attempt).map((entry) => entry.row);
  for (const row of rows) {
    // 逐题当前策略裁决（教师刚改设置立即生效；任一题不可用整体拒绝）。
    // 裁决入口自身的 HttpError（404/403 等权威码）原样上抛，不吞成策略拒绝
    const { resolution } = resolveAttemptQuestionAiPolicy(
      db,
      input.studentId,
      input.attemptId,
      row.questionId,
      configSource,
    );
    if (!resolution.usable || resolution.mode === undefined) {
      throw new HttpError(
        403,
        "AI_POLICY_DISABLED",
        "当前教学模式下本次练习暂不能整体复盘（部分题目的 AI 求助被关闭）",
      );
    }
  }
  return { attempt, rows, released };
}

export function attemptReviewRowsOf(
  db: Db,
  attempt: Attempt,
  hostRows: readonly ResponseRow[],
  dataDir: string | undefined,
) {
  if (!isKernelAttempt(db, attempt)) return hostRows;
  if (dataDir === undefined) kernelAttemptUnavailable();
  const facts = readKernelConfirmationFacts(db, dataDir, attempt);
  if (facts === undefined) kernelAttemptUnavailable();
  return frozenRowsInDisplayOrder(db, facts.attempt, facts.rows).map(
    ({ row }) => row,
  );
}
