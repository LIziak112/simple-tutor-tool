import { join } from "node:path";
import type { BackupRestoreFact } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { runBackfills } from "../db/backfill.ts";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { attempts, lectures, sessions } from "../db/schema.ts";
import { backupRestoreFacts } from "../db/schema-backup-restore-facts.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import { verifyBackupDirectory } from "./backup-kernel-pair.ts";
import {
  protectionConflict,
  readRestoreFacts,
  sessionTokenSha256,
} from "./backup-restore-facts.ts";
import { purgeLecture, purgeUnit } from "./library-service.ts";

function reapplyPurge(
  db: Db,
  {
    resourceKind,
    teacherId,
    resourceId,
  }: Extract<BackupRestoreFact, { kind: "resourcePurge" }>,
) {
  try {
    if (resourceKind === "unit") {
      purgeUnit(db, teacherId, resourceId);
    } else {
      const lecture = db
        .select({ id: lectures.id })
        .from(lectures)
        .where(
          and(eq(lectures.id, resourceId), eq(lectures.teacherId, teacherId)),
        )
        .get();
      if (
        lecture &&
        db
          .select({ id: attempts.id })
          .from(attempts)
          .where(eq(attempts.lectureId, resourceId))
          .get()
      )
        protectionConflict();
      purgeLecture(db, teacherId, resourceId);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.code === "UNIT_NOT_FOUND" || error.code === "LECTURE_NOT_FOUND")
        return;
      if (error.code === "RESOURCE_IN_USE") protectionConflict();
    }
    throw error;
  }
}

/** 只改已完成归档校验的暂存库，调用方持有恢复独占锁。 */
export function protectStagedRestore(
  current: Db,
  staging: string,
  dbFilename: string,
): void {
  const local = readRestoreFacts(current);
  if (local.length === 0) return;
  const incoming = createDb(join(staging, dbFilename));
  try {
    runMigrations(incoming);
    runBackfills(incoming);
    incoming.$client
      .transaction(() => {
        const archived = new Map(
          readRestoreFacts(incoming).map((entry) => [entry.id, entry.fact]),
        );
        const revoked = new Set<string>();
        for (const entry of local) {
          const previous = archived.get(entry.id);
          if (
            previous &&
            canonicalJsonOf(previous) !== canonicalJsonOf(entry.fact)
          )
            protectionConflict();
          if (entry.fact.kind === "sessionRevocation") {
            revoked.add(entry.fact.tokenSha256);
          } else if (previous === undefined) {
            // 归档已见过同一彻删凭据时，同名资源可由其后合法重建。
            reapplyPurge(incoming, entry.fact);
          }
          if (previous === undefined)
            incoming.insert(backupRestoreFacts).values(entry).run();
        }
        if (revoked.size > 0) {
          for (const { id } of incoming
            .select({ id: sessions.id })
            .from(sessions)
            .all()) {
            if (revoked.has(sessionTokenSha256(id)))
              incoming.delete(sessions).where(eq(sessions.id, id)).run();
          }
        }
      })
      .immediate();
  } finally {
    incoming.$client.close();
  }
  // 上一步只重施宿主事实，切换前再次核对双库与冻结原稿。
  verifyBackupDirectory(staging, dbFilename);
}
