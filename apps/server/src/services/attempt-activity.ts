import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts } from "../db/schema";

/** 仅在作答有效写入的同一事务中调用；失败与幂等重放不得更新时间。 */
export function touchAttemptActivity(
  db: Pick<Db, "update">,
  attemptId: string,
  now: string,
): void {
  db.update(attempts)
    .set({
      lastActivityAt: sql`max(coalesce(${attempts.lastActivityAt}, ${attempts.startedAt}), ${now})`,
    })
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, "draft")))
    .run();
}
