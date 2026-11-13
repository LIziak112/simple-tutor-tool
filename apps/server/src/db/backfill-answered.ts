import { studentAnswerSchema } from "@tutor/contract";
import { isUnanswered } from "@tutor/grading";
import { eq, gt } from "drizzle-orm";
import type { Tx } from "../services/question-sync.ts";
import { jsonOf } from "../services/snapshot.ts";
import { attempts, ink, responses } from "./schema.ts";

/**
 * 0044 responses.answered 存量回填（#6980-3，一次性，标记
 * t6980_3_answered_backfill 防重跑）。迁移 SQL 只做 DDL（db-change 规范），
 * 数据回填在代码里完成，幂等可重跑。
 *
 * 回填口径（与判分写点一致）：
 * - 非空答案（isUnanswered 为 false）→ true；
 * - 正式手写笔迹（ink.strokeCount>0，ink 表 (attempt_id, question_id) 唯一键；
 *   responses.inkId 是 T2.8 遗留列、恒空，不作数）→ true；
 * - 单题主动提交 → true（practice_mutation_id 非空；或行 submittedAt 与整卷
 *   attempts.submittedAt 都非空且不同——单题提交先于整卷收尾，时刻可区分；
 *   整卷交卷/提前交卷的行 submittedAt 恒等于 attempt.submittedAt，不算）。
 *   「不会，提交并看解析」的空提交即落在此类——显式交锋计已答（主人口径）。
 * - draft 卷且未单题提交的行（含已保存草稿答案的行）一律不回填——answered
 *   是判分写点落库的事实，交卷/单题提交时才成立（不污染 draft 行）。
 */
export function backfill6980Answered(tx: Tx): void {
  const rows = tx
    .select({
      id: responses.id,
      attemptId: responses.attemptId,
      questionId: responses.questionId,
      answerJson: responses.answerJson,
      submittedAt: responses.submittedAt,
      practiceMutationId: responses.practiceMutationId,
      attemptStatus: attempts.status,
      attemptSubmittedAt: attempts.submittedAt,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .all();
  const inkKeys = new Set(
    tx
      .select({ attemptId: ink.attemptId, questionId: ink.questionId })
      .from(ink)
      .where(gt(ink.strokeCount, 0))
      .all()
      .map((row) => `${row.attemptId}\u0000${row.questionId}`),
  );
  for (const row of rows) {
    const singleSubmitted =
      row.practiceMutationId !== null ||
      (row.submittedAt !== null &&
        (row.attemptSubmittedAt === null ||
          row.submittedAt !== row.attemptSubmittedAt));
    // draft 卷且未单题提交的行不回填（answered 在提交时才成立）
    if (row.attemptStatus === "draft" && !singleSubmitted) continue;
    const answer =
      row.answerJson === null
        ? null
        : studentAnswerSchema.safeParse(jsonOf(row.answerJson)).success === true
          ? studentAnswerSchema.parse(jsonOf(row.answerJson))
          : null;
    const hasAnswer = answer !== null && !isUnanswered(answer);
    const hasInk = inkKeys.has(`${row.attemptId}\u0000${row.questionId}`);
    if (hasAnswer || hasInk || singleSubmitted) {
      tx.update(responses)
        .set({ answered: true })
        .where(eq(responses.id, row.id))
        .run();
    }
  }
}
