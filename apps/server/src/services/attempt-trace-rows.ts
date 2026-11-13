import { and, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import type { TraceEventRow } from "./trace-intervals";

/** 按写入顺序截断，交卷同毫秒内的迟到事件也不会进入学情和导出。 */
export function attemptTraceRowsByAttempt(
  db: Db,
  ids: string[],
  asOf?: string,
): Map<string, TraceEventRow[]> {
  const groups = new Map<string, TraceEventRow[]>();
  const confirmed = new Set<string>();
  for (const row of db
    .select({
      attemptId: events.attemptId,
      type: events.type,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      payloadJson: events.payloadJson,
      isConfirmed: sql<number>`CASE WHEN ${events.type} = 'submit' AND json_valid(${events.payloadJson}) THEN json_extract(${events.payloadJson}, '$.confirmed') ELSE 0 END`,
    })
    .from(events)
    .where(
      and(
        inArray(events.attemptId, ids),
        asOf === undefined ? undefined : lte(events.serverTs, asOf),
      ),
    )
    .orderBy(sql`rowid`)
    .all()) {
    if (row.attemptId === null || confirmed.has(row.attemptId)) continue;
    const group = groups.get(row.attemptId) ?? [];
    group.push(row);
    groups.set(row.attemptId, group);
    if (row.isConfirmed === 1) confirmed.add(row.attemptId);
  }
  return groups;
}
