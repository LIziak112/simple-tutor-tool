import type { AttemptResultCounts } from "@tutor/contract";
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, responses } from "../db/schema";

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
        correctCount: sql<number>`sum(case when ${responses.finalCorrect} = 1 then 1 else 0 end)`,
        pendingCount: sql<number>`sum(case when ${responses.finalCorrect} is null and ${responses.reviewEligible} = 0 then 1 else 0 end)`,
        pendingSelfReviewCount: sql<number>`sum(case when ${responses.finalCorrect} is null and ${responses.reviewEligible} = 1 then 1 else 0 end)`,
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
