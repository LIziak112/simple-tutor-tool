import { createHash, randomUUID } from "node:crypto";
import type { EventDelivery, LearningEventBatchData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import {
  attemptEventReceipts,
  attemptTimeProfiles,
} from "../db/attempt-time-schema";
import type { Db } from "../db/client";
import { events, type NewEventRow } from "../db/schema";
import { HttpError } from "../lib/http-error";
import type { Tx } from "./question-sync";

/** 事件行 → { events: [...] }（逐条校验后的合法输入）批量插入，返回落库条数 */
export function insertEvents(
  db: Db | Tx,
  rows: readonly NewEventRow[],
  delivery?: EventDelivery,
  scope?: string,
): LearningEventBatchData {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const normalized = rows.map((row, index) => ({
      ...row,
      id:
        delivery && scope
          ? eventRowId(delivery.ownerId, scope, delivery.eventIds[index])
          : randomUUID(),
      serverTs: now,
    }));
    const result = db
      .insert(events)
      .values(normalized)
      .onConflictDoNothing({ target: events.id })
      .returning({ id: events.id, attemptId: events.attemptId })
      .all();
    const inserted = new Set(result.map((r) => r.id));
    const profiles = new Map<string, boolean>();
    for (const row of normalized.filter((r) => inserted.has(r.id))) {
      if (row.attemptId && !profiles.has(row.attemptId))
        profiles.set(
          row.attemptId,
          !!db
            .select()
            .from(attemptTimeProfiles)
            .where(eq(attemptTimeProfiles.attemptId, row.attemptId))
            .get(),
        );
      if (row.attemptId && profiles.get(row.attemptId)) {
        db.insert(attemptEventReceipts)
          .values({
            attemptId: row.attemptId,
            eventId: row.id,
            origin: scope?.startsWith("attempt:") ? "client" : "server",
            kind: "event",
            receivedAt: now,
          })
          .run();
      }
    }
    return {
      accepted: result.length,
      ...(delivery && { acknowledgedIds: delivery.eventIds }),
    };
  });
}

/** 新客户端的事件重放使用同一个主键，服务端内部事件继续使用随机主键。 */
function eventRowId(
  ownerId: string,
  scope: string,
  eventId: string | undefined,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([ownerId, scope, eventId]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function validateDelivery(
  studentId: string,
  count: number,
  delivery?: EventDelivery,
): void {
  if (!delivery) return;
  if (delivery.ownerId !== studentId)
    throw new HttpError(403, "EVENT_ACCOUNT_CHANGED", "事件会话已切换");
  if (
    delivery.eventIds.length !== count ||
    new Set(delivery.eventIds).size !== count
  )
    throw new HttpError(400, "EVENT_IDS_INVALID", "事件标识与批次不符");
}
