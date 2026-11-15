import { noteRevisionConflictCurrentSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NoteRow, noteVersions } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";

// ---------- CAS 冲突错误构造 ----------

/**
 * 409 NOTE_REVISION_CONFLICT + 当前版本摘要（_current：客户端据此提示
 * 「保留云端或将本地另存一份」，方案 §6.2 禁止自动覆盖/拼接）。
 */
export function revisionConflict(
  db: Db,
  existing: NoteRow | undefined,
): HttpError {
  // 无 head（revision=0）时除 revision 外全空；有 head 时补版本 hash——
  // 组装经契约 noteRevisionConflictCurrentSchema.parse（复审⑤：摘要形态
  // 契约化，服务端与实现漂移即编程错误在这里当场暴露）
  const headHash = noteVersionHashOf(db, existing?.currentVersionId);
  return new HttpError(
    409,
    "NOTE_REVISION_CONFLICT",
    "草稿已在别处保存了更新的版本（其他标签页/设备），请刷新后选择保留哪一份",
    {
      _current: noteRevisionConflictCurrentSchema.parse({
        noteId: existing?.id ?? null,
        revision: existing?.currentRevision ?? 0,
        versionId: existing?.currentVersionId ?? null,
        hash: headHash ?? null,
        serverSavedAt: existing?.serverSavedAt ?? null,
      }),
    },
  );
}

/** CAS诊断与实质内容比较共用版本hash读取。 */
export function noteVersionHashOf(
  db: Pick<Db, "select">,
  id: string | null | undefined,
): string | undefined {
  return id == null
    ? undefined
    : db
        .select({ hash: noteVersions.hash })
        .from(noteVersions)
        .where(eq(noteVersions.id, id))
        .get()?.hash;
}
