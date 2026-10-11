import { type RefObject, useCallback, useSyncExternalStore } from "react";
import {
  type AnnotationRecordView,
  getAnnotationView,
  retryAnnotationPersistence,
  subscribeAnnotationStore,
} from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import {
  getNoteView,
  type NoteRecordView,
  retryNotePersistence,
  subscribeNoteStore,
} from "@/features/notes/note-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import {
  type DraftPersistenceState,
  draftStore,
  getDraftPersistenceState,
  subscribeDraftPersistence,
} from "./draft-store";
import type { DraftSaveStatus } from "./use-draft-sync";
import type { InkUploadController } from "./use-ink-upload";

type SaveView = Pick<NoteRecordView | AnnotationRecordView, "local" | "server">;
interface SaveSummaryInput {
  answer: DraftSaveStatus;
  local: DraftPersistenceState;
  online: boolean;
  inkDirty: boolean;
  notes: readonly SaveView[];
  annotations: readonly SaveView[];
}
export function summarizeAttemptSaveStatus(input: SaveSummaryInput): string {
  const views = [...input.notes, ...input.annotations];
  if (input.local === "failed" || views.some((view) => view.local === "failed"))
    return "本机保存失败，请保持页面打开并重试";
  if (input.answer.state === "denied") return "已无权限访问该练习";
  if (input.local === "saving" || views.some((view) => view.local === "saving"))
    return "正在保存到本机…";
  if (
    views.some((view) => view.server === "conflict" || view.server === "denied")
  )
    return "有稿件同步需处理，本机稿已保留";
  if (!input.online) return "离线，已存本机";
  if (input.answer.state === "offline") return "已存本机，等待同步";
  if (
    input.answer.state === "saving" ||
    input.inkDirty ||
    views.some((view) => view.server !== "synced")
  )
    return "已存本机，正在同步…";
  return "全部已保存";
}
export const subscribeAttemptSaveChanges = (listener: () => void) => {
  const stops = [
    subscribeNoteStore(listener),
    subscribeAnnotationStore(listener),
    subscribeDraftPersistence(listener),
  ];
  return () => {
    for (const stop of stops) stop();
  };
};

export interface AttemptSaveDetail {
  questionId: string;
  questionNo: number;
  answer: string;
  ink: string;
  scratch: string;
  annotation: string;
}
function recordSaveLabel(view: SaveView | null): string {
  if (!view) return "未使用";
  if (view.local === "failed") return "本机保存失败";
  if (view.local === "saving") return "正在存本机";
  if (view.server === "conflict") return "同步冲突，本机稿已保留";
  if (view.server === "denied") return "无权限同步，本机稿已保留";
  return view.server === "synced" ? "已保存" : "等待同步";
}

/** 弹层打开才消费，仅读标量；同一状态字符串不会触发整卷重渲染。 */
export function readAttemptSaveDetails(
  attemptId: string,
  questionIds: readonly string[],
  controllers: ReadonlyMap<string, Pick<InkUploadController, "isDirty">>,
): AttemptSaveDetail[] {
  const noteSession = currentNoteSession();
  const annotationSession = currentAnnotationSession();
  const local = getDraftPersistenceState(attemptId);
  return questionIds.flatMap((questionId, index) => {
    const scope = { attemptId, questionId, phase: "scratch" as const };
    const noteView = noteSession ? getNoteView(noteSession, scope) : null;
    const note =
      noteView &&
      (noteView.noteId !== null ||
        noteView.pendingMutationId !== null ||
        noteView.docVersion > 0 ||
        noteView.local !== "saved" ||
        noteView.server !== "synced")
        ? noteView
        : null;
    const annotation = annotationSession
      ? getAnnotationView(annotationSession, scope)
      : null;
    const flags = draftStore.getSaveFlags(attemptId, questionId);
    const inkDirty = controllers.get(questionId)?.isDirty();
    if (!flags.hasAnswer && !flags.hasInk && !inkDirty && !note && !annotation)
      return [];
    const localProblem =
      local === "failed"
        ? "本机保存失败"
        : local === "saving"
          ? "正在存本机"
          : null;
    return [
      {
        questionId,
        questionNo: index + 1,
        answer: flags.hasAnswer
          ? (localProblem ?? (flags.answerPending ? "等待同步" : "已保存"))
          : "未填写",
        ink:
          flags.hasInk || inkDirty
            ? (localProblem ??
              (inkDirty
                ? "等待同步"
                : inkDirty === false
                  ? "已保存"
                  : "状态待核对"))
            : "未使用",
        scratch: recordSaveLabel(note),
        annotation: recordSaveLabel(annotation),
      },
    ];
  });
}

/** 各域沿用原仓的落盘队列；重试不改变答案、笔迹或云端回执。 */
export async function retryAttemptLocalPersistence(
  attemptId: string,
  questionIds: readonly string[],
): Promise<void> {
  const noteSession = currentNoteSession();
  const annotationSession = currentAnnotationSession();
  const writes: Promise<void>[] = [draftStore.flush(attemptId)];
  for (const questionId of questionIds) {
    const scope = { attemptId, questionId, phase: "scratch" as const };
    if (noteSession) writes.push(retryNotePersistence(noteSession, scope));
    if (annotationSession)
      writes.push(retryAnnotationPersistence(annotationSession, scope));
  }
  // 等所有域结束后再报告失败，避免仍在写入时再次发起重试。
  const results = await Promise.allSettled(writes);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (getDraftPersistenceState(attemptId) === "failed")
    throw new Error("本机答案保存失败，请保持页面打开");
}

/** 只读各域标量快照，不建新仓、不遍历笔点；同文案不触发整卷重渲染。 */
export function useAttemptSaveStatus(
  attemptId: string,
  questionIds: readonly string[],
  answer: DraftSaveStatus,
  online: boolean,
  controllers: RefObject<Map<string, InkUploadController>>,
): string {
  const getSnapshot = useCallback(() => {
    const noteSession = currentNoteSession();
    const annotationSession = currentAnnotationSession();
    const notes: SaveView[] = [];
    const annotations: SaveView[] = [];
    for (const questionId of questionIds) {
      const scope = { attemptId, questionId, phase: "scratch" as const };
      const note = noteSession ? getNoteView(noteSession, scope) : null;
      const annotation = annotationSession
        ? getAnnotationView(annotationSession, scope)
        : null;
      if (note) notes.push(note);
      if (annotation) annotations.push(annotation);
    }
    return summarizeAttemptSaveStatus({
      answer,
      local: getDraftPersistenceState(attemptId),
      online,
      inkDirty: [...controllers.current.values()].some((controller) =>
        controller.isDirty(),
      ),
      notes,
      annotations,
    });
  }, [attemptId, questionIds, answer, online, controllers]);
  return useSyncExternalStore(
    subscribeAttemptSaveChanges,
    getSnapshot,
    getSnapshot,
  );
}
