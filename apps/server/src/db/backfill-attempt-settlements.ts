import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { writeFinalSettlementWithin } from "../services/attempt-settlement.ts";
import type { Db } from "./client.ts";
import { attempts, dataMigrations } from "./schema.ts";

const KEY = "attempt_final_settlements_v1";

/** 所有历史完成卷补唯一 final，含旧协议/作废完成卷；只写归属及完成标记。 */
export function backfillAttemptSettlements(db: Db, now: Date): void {
  const applied = (tx: Pick<Db, "select">) =>
    tx
      .select({ key: dataMigrations.key })
      .from(dataMigrations)
      .where(eq(dataMigrations.key, KEY))
      .get() !== undefined;
  if (applied(db)) return;
  db.transaction(
    (tx) => {
      if (applied(tx)) return;
      let afterId = "";
      for (;;) {
        const candidates = tx
          .select({ id: attempts.id })
          .from(attempts)
          .where(
            and(
              inArray(attempts.status, ["submitted", "graded"]),
              gt(attempts.id, afterId),
            ),
          )
          .orderBy(asc(attempts.id))
          .limit(200)
          .all();
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          writeFinalSettlementWithin(tx, candidate.id);
          afterId = candidate.id;
        }
      }
      tx.insert(dataMigrations)
        .values({ key: KEY, appliedAt: now.toISOString() })
        .run();
    },
    { behavior: "immediate" },
  );
}
