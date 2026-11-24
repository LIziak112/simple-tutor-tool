import { createHash, randomUUID } from "node:crypto";
import {
  type BackupRestoreFact,
  backupRestoreFactSchema,
} from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { backupRestoreFacts } from "../db/schema-backup-restore-facts.ts";
import { HttpError } from "../lib/http-error.ts";

type FactsWriter = Pick<Db, "insert">;
type ResourcePurge = Extract<BackupRestoreFact, { kind: "resourcePurge" }>;

export function sessionTokenSha256(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function protectionConflict(): never {
  throw new HttpError(
    409,
    "BACKUP_RESTORE_PROTECTION_CONFLICT",
    "归档数据与本实例的撤销或彻删依据冲突，保留现用数据",
  );
}

export function recordRevokedSessions(
  db: FactsWriter,
  sessions: readonly { id: string }[],
): void {
  for (const { id } of sessions) {
    const tokenSha256 = sessionTokenSha256(id);
    db.insert(backupRestoreFacts)
      .values({
        id: tokenSha256,
        fact: { kind: "sessionRevocation", tokenSha256 },
      })
      .onConflictDoNothing()
      .run();
  }
}

export function recordResourcePurge(
  db: FactsWriter,
  resourceKind: ResourcePurge["resourceKind"],
  teacherId: string,
  resourceId: string,
): void {
  db.insert(backupRestoreFacts)
    .values({
      id: randomUUID(),
      fact: { kind: "resourcePurge", resourceKind, teacherId, resourceId },
    })
    .run();
}

export function readRestoreFacts(db: Pick<Db, "select">) {
  return db
    .select()
    .from(backupRestoreFacts)
    .all()
    .map(({ id, fact }) => {
      const parsed = backupRestoreFactSchema.safeParse(fact);
      if (
        !parsed.success ||
        (parsed.data.kind === "sessionRevocation" &&
          parsed.data.tokenSha256 !== id)
      )
        protectionConflict();
      return { id, fact: parsed.data };
    });
}
