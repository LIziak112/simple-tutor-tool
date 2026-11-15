import type { AttemptSummary } from "@tutor/contract";
import {
  type AnnotationLocalRecord,
  getAnnotationRecord,
  listPendingAnnotations,
  settleAnnotationPersistence,
  writeLocalAnnotationBase,
} from "@/features/annotation/annotation-store";
import {
  getNoteRecord,
  loadScratchRecords,
  type NoteLocalRecord,
  settleNotePersistence,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { digestOf } from "./draft-merge";
import { currentDraftSession } from "./draft-store";

export interface LocalAttemptAttachments {
  notes: Map<string, NoteLocalRecord>;
  annotations: Map<string, AnnotationLocalRecord>;
}
/** 草稿和标画已有按主体/卷扫描接口，不造第二份笔迹仓。 */
export async function readLocalAttemptAttachments(
  attemptId: string,
): Promise<LocalAttemptAttachments> {
  const session = currentDraftSession();
  const result: LocalAttemptAttachments = {
    notes: new Map(),
    annotations: new Map(),
  };
  if (!session) return result;
  await Promise.all([settleNotePersistence(), settleAnnotationPersistence()]);
  const notes = await loadScratchRecords(session, attemptId, {
    strictRead: true,
  });
  for (const [id, record] of notes) {
    if (record.doc.ink.strokes.length || record.doc.ink.deleted?.length)
      result.notes.set(id, record);
  }
  const scopes = await listPendingAnnotations(session, attemptId, {
    strictRead: true,
  });
  for (const scope of scopes) {
    if (scope.phase !== "scratch") continue;
    const record = await getAnnotationRecord(session, scope, {
      strictRead: true,
    });
    if (
      record &&
      (record.doc.strokes.length ||
        record.doc.deleted?.length ||
        Object.keys(record.doc.anchors ?? {}).length)
    )
      result.annotations.set(scope.questionId, record);
  }
  return result;
}
export function hasLocalAttachments(
  attachments: LocalAttemptAttachments,
): boolean {
  return attachments.notes.size > 0 || attachments.annotations.size > 0;
}
export function attachmentsSnapshotConflict(
  attachments: LocalAttemptAttachments,
  attempt: AttemptSummary,
): boolean {
  const refrozen =
    attempt.frozenAt != null && attempt.frozenAt !== attempt.startedAt;
  return [
    ...attachments.notes.values(),
    ...attachments.annotations.values(),
  ].some((record) => {
    const token = record.pending?.expectedFrozenAt;
    return token === undefined
      ? refrozen && record.pending !== null
      : token !== attempt.frozenAt;
  });
}
export function attachmentsRecoverable(
  attachments: LocalAttemptAttachments,
  revisions: Record<string, string> = {},
): boolean {
  return (
    [...attachments.notes.values()].every(
      (record) => !record.conflict && record.denied?.kind !== "content",
    ) &&
    [...attachments.annotations].every(
      ([id, record]) =>
        record.localBase !== null &&
        !record.conflict &&
        !record.retained &&
        record.denied?.kind !== "content" &&
        revisions[id] !== undefined,
    )
  );
}
/** 核对版本后仍沿用原草稿/底图；新卷只重新绑定提交行，不重画坐标或合并原稿。 */
export async function copyLocalAttemptAttachments(
  attemptId: string,
  attachments: LocalAttemptAttachments,
  revisions: Record<string, string>,
  assertCurrent: () => void,
  expectedFrozenAt?: string | null,
): Promise<void> {
  const session = currentDraftSession();
  if (!session) throw new Error("作答材料会话尚未就绪");
  for (const [questionId, record] of attachments.notes) {
    assertCurrent();
    const scope = { attemptId, questionId, phase: "scratch" as const };
    const current = await getNoteRecord(session, scope, { strictRead: true });
    assertCurrent();
    if (
      current &&
      (current.doc.ink.strokes.length || current.doc.ink.deleted?.length)
    ) {
      if (digestOf(current.doc) !== digestOf(record.doc))
        throw new Error("新卷已有另一份草稿，旧本机原稿已保留，请先核对");
      continue;
    }
    writeNoteDoc(session, scope, structuredClone(record.doc), expectedFrozenAt);
  }
  await settleNotePersistence();
  assertCurrent();
  for (const [questionId, record] of attachments.annotations) {
    const base = record.localBase;
    const revision = revisions[questionId];
    if (!base || !revision)
      throw new Error("旧圈画缺少底图或题版本，原稿已保留");
    assertCurrent();
    const scope = { attemptId, questionId, phase: "scratch" as const };
    const current = await getAnnotationRecord(session, scope, {
      strictRead: true,
    });
    assertCurrent();
    if (current?.doc.strokes.length) {
      if (digestOf(current.doc) !== digestOf(record.doc))
        throw new Error("新卷已有另一份圈画，旧本机原稿已保留，请先核对");
      continue;
    }
    await writeLocalAnnotationBase(
      session,
      scope,
      {
        png: base.png,
        layout: { ...base.layout, questionRevisionId: revision },
      },
      structuredClone(record.doc),
      undefined,
      expectedFrozenAt,
    );
    assertCurrent();
  }
}
