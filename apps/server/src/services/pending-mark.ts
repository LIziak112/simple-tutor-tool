import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, responses } from "../db/schema";

/**
 * 共享待批谓词（D4，T3.2a）——全站唯一口径：
 * **待批题 ≡ 已交卷 attempt 中 `responses.finalCorrect IS NULL` 的题**；
 * draft 恒 0（未交卷不构成待批）。
 *
 * 设计依据：
 * - D3 持久化口径（交卷同时写 finalCorrect = teacherMark ?? autoCorrect）下与
 *   「autoCorrect 为 null 且教师未批」严格等价；由此「待批数 = 0 ⇔ status =
 *   graded」（D2 状态机）在全站成立；
 * - **不得叠加 `answerJson 非空` 条件**（T3.2a 前的旧口径）：只写笔迹、未填
 *   最终答案的手写题 answerJson 为 null，却正是最需要批改的题——旧条件会漏掉
 *   它们并让该 attempt 永远到不了 graded；
 * - 消费方：course-service（进度矩阵）、student-course-service（单元卡片）、
 *   teacher-attempt-service（数据页卡片与详情）；T3.2b 待批队列同口径复用。
 *
 * 独立小模块（只依赖 db + schema）：避免 service 之间互相引用形成循环依赖。
 */

/** 判定输入的最小形态（attempt 行裁剪：只需要 id 与状态） */
export type PendingMarkAttempt = Pick<Attempt, "id" | "status">;

/** 单个 attempt 的待批题数（draft 恒 0） */
export function pendingMarkCount(
  db: Db,
  attempt: PendingMarkAttempt,
): number {
  if (attempt.status === "draft") return 0;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(responses)
      .where(
        and(eq(responses.attemptId, attempt.id), isNull(responses.finalCorrect)),
      )
      .get()?.n ?? 0
  );
}

/**
 * 批量待批数：attemptId → 该 attempt 的待批题数（分组一次查询，500 id 一块）。
 * 只统计非 draft 的输入（draft 恒 0，不出现在结果 Map 中——调用方按
 * `map.get(id) ?? 0` 取值即可）。
 */
export function pendingMarkCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, number> {
  const map = new Map<string, number>();
  const submittedIds = attempts
    .filter((attempt) => attempt.status !== "draft")
    .map((attempt) => attempt.id);
  for (let start = 0; start < submittedIds.length; start += 500) {
    const chunk = submittedIds.slice(start, start + 500);
    for (const row of db
      .select({ attemptId: responses.attemptId, n: sql<number>`count(*)` })
      .from(responses)
      .where(
        and(
          inArray(responses.attemptId, chunk),
          isNull(responses.finalCorrect),
        ),
      )
      .groupBy(responses.attemptId)
      .all()) {
      map.set(row.attemptId, row.n);
    }
  }
  return map;
}
