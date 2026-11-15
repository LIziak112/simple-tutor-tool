import type { Page, TestInfo } from "@playwright/test";
import type {
  AnnotationConflictCurrent,
  NoteHeadData,
  NoteRevisionConflictCurrent,
} from "../../packages/contract/src";

type Session = { origin: string; studentId: string };
type Scope = { attemptId: string; questionId: string; phase: "scratch" };
type RecordScalars = {
  local: string;
  baseRevision: number;
  pending: { mutationId: string } | null;
  denied: { kind: string; reason: string } | null;
};
type NoteScalars = RecordScalars & {
  lastHead: NoteHeadData | null;
  conflict: {
    reason: string;
    current: NoteRevisionConflictCurrent | null;
  } | null;
};
type AnnotationScalars = RecordScalars & {
  conflict: {
    kind: string;
    reason: string;
    current: AnnotationConflictCurrent | null;
  } | null;
};
type NoteStore = {
  peekNoteRecord(session: Session, scope: Scope): NoteScalars | null;
  getNoteView(session: Session, scope: Scope): { server: string };
};
type AnnotationStore = {
  peekAnnotationRecord(
    session: Session,
    scope: Scope,
  ): AnnotationScalars | null;
  getAnnotationView(session: Session, scope: Scope): { server: string };
};

/** 仅失败时采集真实内存标量；不读取笔点、正文、图片或凭据。 */
export async function attachMaterialSyncFailure(page: Page, info: TestInfo) {
  try {
    const snapshot = await page.evaluate(async () => {
      const paths = {
        notes: "/src/features/notes/note-store.ts",
        noteSync: "/src/features/notes/note-sync.ts",
        annotations: "/src/features/annotation/annotation-store.ts",
        annotationSync: "/src/features/annotation/annotation-sync.ts",
      };
      const notes = (await import(paths.notes)) as unknown as NoteStore;
      const noteSync = (await import(paths.noteSync)) as unknown as {
        currentNoteSession(): Session | null;
      };
      const annotations = (await import(
        paths.annotations
      )) as unknown as AnnotationStore;
      const annotationSync = (await import(
        paths.annotationSync
      )) as unknown as { currentAnnotationSession(): Session | null };
      const noteSession = noteSync.currentNoteSession();
      const annotationSession = annotationSync.currentAnnotationSession();
      const attemptId =
        location.pathname.split("/attempts/")[1]?.split("/")[0] ?? "";
      const ids = [
        ...new Set(
          Array.from(document.querySelectorAll("[data-question-id]"))
            .map((node) => node.getAttribute("data-question-id"))
            .filter((id): id is string => id !== null),
        ),
      ];
      return {
        attemptId,
        noteSession: noteSession
          ? { origin: noteSession.origin, studentId: noteSession.studentId }
          : null,
        annotationSession: annotationSession
          ? {
              origin: annotationSession.origin,
              studentId: annotationSession.studentId,
            }
          : null,
        questions: ids.map((questionId) => {
          const scope = { attemptId, questionId, phase: "scratch" as const };
          const note = noteSession
            ? notes.peekNoteRecord(noteSession, scope)
            : null;
          const annotation = annotationSession
            ? annotations.peekAnnotationRecord(annotationSession, scope)
            : null;
          return {
            questionId,
            scope,
            note:
              note && noteSession
                ? {
                    server: notes.getNoteView(noteSession, scope).server,
                    local: note.local,
                    baseRevision: note.baseRevision,
                    headRevision: note.lastHead?.note?.revision ?? null,
                    pendingMutationId: note.pending?.mutationId ?? null,
                    conflict: note.conflict
                      ? {
                          reason: note.conflict.reason,
                          revision: note.conflict.current?.revision ?? null,
                          hash: note.conflict.current?.hash ?? null,
                        }
                      : null,
                    denied: note.denied
                      ? { kind: note.denied.kind, reason: note.denied.reason }
                      : null,
                  }
                : null,
            annotation:
              annotation && annotationSession
                ? {
                    server: annotations.getAnnotationView(
                      annotationSession,
                      scope,
                    ).server,
                    local: annotation.local,
                    baseRevision: annotation.baseRevision,
                    headRevision:
                      annotation.conflict?.current?.revision ?? null,
                    pendingMutationId: annotation.pending?.mutationId ?? null,
                    conflict: annotation.conflict
                      ? {
                          kind: annotation.conflict.kind,
                          reason: annotation.conflict.reason,
                        }
                      : null,
                    denied: annotation.denied
                      ? {
                          kind: annotation.denied.kind,
                          reason: annotation.denied.reason,
                        }
                      : null,
                  }
                : null,
          };
        }),
      };
    });
    await info.attach("material-sync-failure-scalars", {
      body: JSON.stringify(snapshot, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    await info.attach("material-sync-capture-error", {
      body: String(error),
      contentType: "text/plain",
    });
  }
}
