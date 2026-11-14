import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attemptSettlements } from "../db/schema.ts";
/** 分页列表批量聚合；大列表分块避免SQLite变量上限。 */
export function settlementCountsOf(db: Db, attemptIds: readonly string[]) {
  const counts = new Map<string, number>();
  for (let offset = 0; offset < attemptIds.length; offset += 500) {
    const rows = db
      .select({
        attemptId: attemptSettlements.attemptId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(attemptSettlements)
      .where(
        inArray(
          attemptSettlements.attemptId,
          attemptIds.slice(offset, offset + 500),
        ),
      )
      .groupBy(attemptSettlements.attemptId)
      .all();
    for (const row of rows) counts.set(row.attemptId, row.count);
  }
  return counts;
}
