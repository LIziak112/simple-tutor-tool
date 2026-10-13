import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, responses } from "../db/schema";

/**
 * 共享待批谓词（D4，T3.2a）——全站唯一口径：
 * **待批题 ≡ 「已交」的题中 `responses.finalCorrect IS NULL` 的题**。
 * 「已交」= attempt 非 draft **或该行已单题提交**（responses.submittedAt 非空，
 * 2026-10 讲练一体扩：lesson 进行中卷已提交的手写/无答案题即时进教师待批，
 * 课堂当场批改；只有 lesson 单题提交会写该列，非 lesson 行为零变化）。
 *
 * 设计依据：
 * - D3 持久化口径（交卷同时写 finalCorrect = teacherMark ?? autoCorrect）下与
 *   「autoCorrect 为 null 且教师未批」严格等价；由此「待批数 = 0 ⇔ status =
 *   graded」（D2 状态机）在全站成立（lesson 卷在离开 draft 前教师批改的行
 *   finalCorrect 已定，同样不计数）；
 * - **不得叠加 `answerJson 非空` 条件**（T3.2a 前的旧口径）：只写笔迹、未填
 *   最终答案的手写题 answerJson 为 null，却正是最需要批改的题——旧条件会漏掉
 *   它们并让该 attempt 永远到不了 graded；
 * - **叠加 `questionSnapshotJson 非空`（T6R.3）**：排除「历史题目缺失」的
 *   幽灵行（升级遗留卷中软删/缺失题的行——不进判分、不进任何视图，若计入
 *   待批会让 attempt 永卡 submitted 且队列出现不可批的空卡片）；
 * - 消费方：course-service（进度矩阵）、student-course-service（单元卡片）、
 *   teacher-attempt-service（数据页卡片与详情）、mark-response（待批队列）、
 *   student-records（记录行待批数）。T3.2b 待批队列同口径复用。
 *
 * 独立小模块（只依赖 db + schema）：避免 service 之间互相引用形成循环依赖。
 */

/** 判定输入的最小形态（attempt 行裁剪：只需要 id 与状态） */
export type PendingMarkAttempt = Pick<Attempt, "id" | "status">;

/**
 * D4 待批行的共享条件（不含 attempt 归属筛选——单卷 eq / 批量 inArray 各自给）：
 * finalCorrect IS NULL + 快照非空（排幽灵行）+ draft 批次叠加行级已提交
 * （2026-10 讲练一体扩：lesson 进行中卷只数已单题提交的行，课堂当场批改；
 * 非 lesson 的 draft 恒 0。非 draft 批次整卷恒「已交」，保持既有口径不加
 * 条件——设计依据详见模块头注释）。两函数（单卷/批量）共用本构造器，
 * 口径永不漂移。
 */
function pendingMarkConditions(draft: boolean): (SQL | undefined)[] {
  return [
    isNull(responses.finalCorrect),
    isNotNull(responses.questionSnapshotJson),
    draft ? isNotNull(responses.submittedAt) : undefined,
  ];
}

/**
 * 单个 attempt 的待批题数。draft 卷只有 lesson 单题提交会命中
 * （非 lesson 的 draft 恒 0）；非 draft 按整卷既有口径。
 */
export function pendingMarkCount(db: Db, attempt: PendingMarkAttempt): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attempt.id),
          ...pendingMarkConditions(attempt.status === "draft"),
        ),
      )
      .get()?.n ?? 0
  );
}

/**
 * 批量待批数：attemptId → 该 attempt 的待批题数（分组查询，500 id 一块）。
 * 结果 Map 只含有命中的 attempt（调用方按 `map.get(id) ?? 0` 取值）——
 * 非 lesson 的 draft 恒 0 不出现；lesson 进行中卷有已提交待批行时出现。
 */
export function pendingMarkCounts(
  db: Db,
  attempts: readonly PendingMarkAttempt[],
): Map<string, number> {
  const map = new Map<string, number>();
  const idsOf = (draft: boolean) =>
    attempts
      .filter((attempt) => (attempt.status === "draft") === draft)
      .map((attempt) => attempt.id);
  // 非 draft（整卷已交）与 draft（lesson 进行中卷——行级 submittedAt 判定）
  // 两批各查一次；条件差异见 pendingMarkConditions 注释
  for (const [draft, ids] of [
    [false, idsOf(false)],
    [true, idsOf(true)],
  ] as const) {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      for (const row of db
        .select({ attemptId: responses.attemptId, n: sql<number>`count(*)` })
        .from(responses)
        .where(
          and(
            inArray(responses.attemptId, chunk),
            ...pendingMarkConditions(draft),
          ),
        )
        .groupBy(responses.attemptId)
        .all()) {
        map.set(row.attemptId, row.n);
      }
    }
  }
  return map;
}
