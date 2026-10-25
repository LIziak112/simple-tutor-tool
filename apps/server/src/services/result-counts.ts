import type { AttemptResultCounts } from "@tutor/contract";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, responses } from "../db/schema";
import { notSelfReviewPendingRow } from "./pending-mark";

/** 只接收调用方已核验归属的作答；草稿与作废卷不产生整卷结果。 */
export function attemptResultCounts(
  db: Db,
  attempts: readonly (Pick<Attempt, "id" | "status"> &
    Partial<Pick<Attempt, "abandonedAt">>)[],
): Map<string, AttemptResultCounts> {
  const result = new Map<string, AttemptResultCounts>();
  const ids = attempts
    .filter(
      (attempt) => attempt.status !== "draft" && attempt.abandonedAt == null,
    )
    .map((attempt) => attempt.id);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    for (const id of chunk)
      result.set(id, {
        correctCount: 0,
        totalCount: 0,
        pendingCount: 0,
        pendingSelfReviewCount: 0,
      });
    for (const row of db
      .select({
        attemptId: responses.attemptId,
        totalCount: sql<number>`count(*)`,
        // QM-12 有效判定的 SQL 化（与 effectiveVerdictOfRow 单源语义对齐：
        // 教师判 > 自评 > 自动；自评 verdict/at 成对判——脏行降级待判，同
        // wrong-questions 已判定轮谓词）。未做行（answered=false）仍进分母，
        // 只是判错不计判对（#6980-3 与判定维度正交）
        correctCount: sql<number>`sum(case
          when ${responses.teacherMark} = 'correct' then 1
          when ${responses.teacherMark} = 'wrong' then 0
          when ${responses.selfReviewVerdict} is not null and ${responses.selfReviewAt} is not null
            then case when ${responses.selfReviewVerdict} = 'correct' then 1 else 0 end
          when ${responses.autoCorrect} is not null
            then case when ${responses.autoCorrect} = 1 then 1 else 0 end
          else 0 end)`,
        // D4 教师待批（pending-mark 谓词同口径：finalCorrect IS NULL 且非
        // reference_self 行；快照非空已由外层 where 排幽灵行）
        pendingCount: sql<number>`sum(case when ${isNull(responses.finalCorrect)} and ${notSelfReviewPendingRow()} then 1 else 0 end)`,
        // 待自评（与 pending-mark.pendingSelfReviewCounts 同语义：reference_self
        // 行且教师未判且学生未自评——有判定来源即归零）
        pendingSelfReviewCount: sql<number>`sum(case when ${eq(responses.gradingPolicy, "reference_self")} and ${isNull(responses.teacherMark)} and ${isNull(responses.selfReviewVerdict)} then 1 else 0 end)`,
      })
      .from(responses)
      .where(
        and(
          inArray(responses.attemptId, chunk),
          isNotNull(responses.questionSnapshotJson),
        ),
      )
      .groupBy(responses.attemptId)
      .all()) {
      const { attemptId, ...counts } = row;
      result.set(attemptId, counts);
    }
  }
  return result;
}

/** 输入按作答轮次升序；最佳比例相同时取最近一次，零题卷不参与比较。 */
export function resultCountsSummary(
  ids: readonly string[],
  counts: ReadonlyMap<string, AttemptResultCounts>,
) {
  const results = ids.flatMap((id) => {
    const result = counts.get(id);
    return result ? [result] : [];
  });
  let best: AttemptResultCounts | null = null;
  for (const result of results) {
    if (
      result.totalCount > 0 &&
      (best === null ||
        result.correctCount * best.totalCount >=
          best.correctCount * result.totalCount)
    )
      best = result;
  }
  return {
    firstResultCounts: results[0] ?? null,
    latestResultCounts: results.at(-1) ?? null,
    bestResultCounts: best,
  };
}
