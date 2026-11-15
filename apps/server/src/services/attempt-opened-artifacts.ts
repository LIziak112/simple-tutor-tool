import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  annotationBases,
  annotations,
  ink,
  noteImages,
  notes,
  noteVersions,
} from "../db/schema.ts";

/** 仅在同事务已确认无实质内容之后使用；重冻与清除共享空稿/底图FK删除顺序。 */
export function discardOpenedArtifactsWithin(
  db: Pick<Db, "select" | "update" | "delete">,
  attemptId: string,
): void {
  const noteIds = db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.attemptId, attemptId));
  const versionIds = db
    .select({ id: noteVersions.id })
    .from(noteVersions)
    .where(inArray(noteVersions.noteId, noteIds));
  // notes与版本互相引用：先断开空稿头，再删派生图、版本与空稿。
  db.update(notes)
    .set({ currentVersionId: null, currentRevision: 0 })
    .where(eq(notes.attemptId, attemptId))
    .run();
  db.delete(noteImages)
    .where(inArray(noteImages.noteVersionId, versionIds))
    .run();
  db.delete(noteVersions).where(inArray(noteVersions.noteId, noteIds)).run();
  db.delete(notes).where(eq(notes.attemptId, attemptId)).run();
  db.delete(annotations).where(eq(annotations.attemptId, attemptId)).run();
  db.delete(annotationBases)
    .where(eq(annotationBases.attemptId, attemptId))
    .run();
  db.delete(ink).where(eq(ink.attemptId, attemptId)).run();
}
