import { eq, isNull } from "drizzle-orm";
import { hasSubstantiveAttemptEvidence } from "../services/attempt-substantive-evidence.ts";
import type { Db } from "./client.ts";
import { attempts, dataMigrations } from "./schema.ts";

export const ATTEMPT_ACTIVATION_BACKFILL_KEY = "attempt_activation_v1";

/** 历史时刻只能取已知的 startedAt；绝不把升级时刻伪装成首次动作。 */
export function backfillAttemptActivation(db: Db, now = new Date()): number {
  return db.transaction(() => {
    if (
      db
        .select()
        .from(dataMigrations)
        .where(eq(dataMigrations.key, ATTEMPT_ACTIVATION_BACKFILL_KEY))
        .get()
    )
      return 0;
    let count = 0;
    for (const row of db
      .select()
      .from(attempts)
      .where(isNull(attempts.activatedAt))
      .all()) {
      if (
        row.status !== "draft" ||
        row.timeLimitSec !== null ||
        hasSubstantiveAttemptEvidence(db, row.id, true)
      ) {
        count += db
          .update(attempts)
          .set({ activatedAt: row.startedAt })
          .where(eq(attempts.id, row.id))
          .run().changes;
      }
    }
    db.insert(dataMigrations)
      .values({
        key: ATTEMPT_ACTIVATION_BACKFILL_KEY,
        appliedAt: now.toISOString(),
      })
      .run();
    return count;
  });
}
