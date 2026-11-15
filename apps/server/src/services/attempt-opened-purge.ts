import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import { discardOpenedArtifactsWithin } from "./attempt-opened-artifacts.ts";
import { hasSubstantiveAttemptEvidence } from "./attempt-substantive-evidence.ts";

interface PurgeOptions {
  enabled?: boolean;
  days?: number;
  now?: Date;
}

export function openedAttemptPurgeOptionsOf(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  days: number;
} {
  const days = Number(env.ATTEMPT_OPENED_PURGE_DAYS ?? "7");
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("ATTEMPT_OPENED_PURGE_DAYS 必须是1至3650的整数");
  return { enabled: env.ATTEMPT_OPENED_PURGE_ENABLED === "1", days };
}

/** 一期缺省不执行；只清除既未激活又没有任何实质证据的过期暂存卷。 */
export function purgeOpenedAttempts(
  db: Db,
  options: PurgeOptions = {},
): number {
  if (options.enabled !== true) return 0;
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1)
    throw new Error("清除天数必须为正整数");
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - days * 86400_000,
  ).toISOString();
  return db.transaction(
    () => {
      const candidates = db
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.status, "draft"),
            isNull(attempts.activatedAt),
            isNull(attempts.abandonedAt),
            lt(attempts.startedAt, cutoff),
          ),
        )
        .all();
      let removed = 0;
      for (const attempt of candidates) {
        if (
          hasSubstantiveAttemptEvidence(db, attempt.id) ||
          hasOtherProtectedChildren(db, attempt.id)
        )
          continue;
        // 延迟FK仅到本事务提交；先删父行让原有append-only删除触发器正确识别整卷清除。
        // foreign_keys 始终开启，既有活动卷账本与复盘审计保护完全不变。
        db.$client.pragma("defer_foreign_keys = ON");
        db.delete(attempts).where(eq(attempts.id, attempt.id)).run();
        discardOpenedArtifactsWithin(db, attempt.id);
        for (const table of [
          "responses",
          "attempt_context_snapshots",
          "attempt_context_freezes",
          "events",
        ]) {
          db.$client
            .prepare(`DELETE FROM ${table} WHERE attempt_id=?`)
            .run(attempt.id);
        }
        removed += 1;
      }
      return removed;
    },
    { behavior: "immediate" },
  );
}

/** 不属于空快照/浏览事件的旁路子记录一律保守保留，包括未应用的上传分片。 */
function hasOtherProtectedChildren(db: Db, attemptId: string): boolean {
  for (const table of ["attempt_batch_submissions"]) {
    if (
      db.$client
        .prepare(`SELECT 1 FROM ${table} WHERE attempt_id=? LIMIT 1`)
        .get(attemptId)
    )
      return true;
  }
  return false;
}
