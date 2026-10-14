import { useEffect, useSyncExternalStore } from "react";
import {
  applyAnnotationView,
  getAnnotationRecord,
} from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import { useAnnotationSessionRef } from "@/features/annotation/use-annotation-record";
import { seedRecordFromServerHead } from "@/features/notes/note-seed";
import { getNoteRecord } from "@/features/notes/note-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import {
  fetchAnnotationViewApi,
  fetchAttemptMaterialRevisionsApi,
  fetchStudentNoteHeadsApi,
} from "@/lib/api";
import { getDraftSessionEpoch } from "./draft-store";

export type AttemptRecoveryState =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "failed"; message: string; verified?: true };
/** 已成功恢复过的本机稿可离线继续编辑，未知基线仍禁止起空稿。 */
export const attemptMaterialsEditable = (state: AttemptRecoveryState) =>
  state.state === "ready" ||
  (state.state === "failed" && state.verified === true);
const LOADING: AttemptRecoveryState = { state: "loading" };
const READY: AttemptRecoveryState = { state: "ready" };
const states = new Map<string, AttemptRecoveryState>();
const tasks = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const keyOf = (attemptId: string) =>
  JSON.stringify([getDraftSessionEpoch(), attemptId]);
export const subscribeAttemptRecovery = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getAttemptRecoveryState = (
  attemptId: string,
): AttemptRecoveryState => states.get(keyOf(attemptId)) ?? LOADING;
function setState(key: string, state: AttemptRecoveryState) {
  states.set(key, state);
  for (const listener of listeners) listener();
}

/** 本机与标画默认每批四题；失败先等本批结束，避免重试与迟到任务交错。 */
async function recoverInBatches<T>(
  items: readonly T[],
  stale: () => boolean,
  recover: (item: T, index: number) => Promise<void>,
  batchSize = 4,
): Promise<void> {
  for (let start = 0; start < items.length; start += batchSize) {
    if (stale()) return;
    const results = await Promise.allSettled(
      items
        .slice(start, start + batchSize)
        .map((item, index) => recover(item, start + index)),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
}

/** 只读盘点后恢复原有材料；没有确认无稿前不构造空白稿或向云端写入。 */
export function recoverAttemptMaterials(
  attemptId: string,
  questionIds: readonly string[],
): Promise<void> {
  const key = keyOf(attemptId);
  const active = tasks.get(key);
  if (active) return active;
  const verified = attemptMaterialsEditable(getAttemptRecoveryState(attemptId));
  if (!verified) setState(key, LOADING);
  const noteSession = currentNoteSession();
  const annotationSession = currentAnnotationSession();
  const stale = () =>
    keyOf(attemptId) !== key ||
    currentNoteSession() !== noteSession ||
    currentAnnotationSession() !== annotationSession;
  const task = (async () => {
    try {
      if (!noteSession || !annotationSession)
        throw new Error("作答材料会话尚未就绪，请重试");
      const manifest = await fetchAttemptMaterialRevisionsApi(attemptId);
      if (stale()) return;
      const needNotes: string[] = [];
      const needAnnotations: string[] = [];
      await recoverInBatches(questionIds, stale, async (questionId) => {
        const scope = { attemptId, questionId, phase: "scratch" as const };
        const local = await Promise.allSettled([
          getNoteRecord(noteSession, scope, { strictRead: true }),
          getAnnotationRecord(annotationSession, scope, { strictRead: true }),
        ]);
        const [noteResult, annotationResult] = local;
        if (noteResult.status === "rejected") throw noteResult.reason;
        if (annotationResult.status === "rejected")
          throw annotationResult.reason;
        const note = noteResult.value;
        const annotation = annotationResult.value;
        if (stale()) return;
        const noteRevision = manifest.notes[questionId];
        if (
          noteRevision !== undefined &&
          (!note || note.baseRevision !== noteRevision || note.docVersion === 0)
        )
          needNotes.push(questionId);
        const annotationRevision = manifest.annotations[questionId];
        if (
          annotationRevision !== undefined &&
          (!annotation || annotation.baseRevision !== annotationRevision)
        )
          needAnnotations.push(questionId);
      });
      if (stale()) return;
      // 只取存在或版本变动的草稿；多题分批读取，避免整卷逐题请求。
      for (let start = 0; start < needNotes.length; start += 100) {
        const ids = needNotes.slice(start, start + 100);
        const heads = await fetchStudentNoteHeadsApi(attemptId, ids);
        if (stale()) return;
        await recoverInBatches(
          ids,
          stale,
          async (questionId, index) => {
            const head = heads[index];
            if (!head) throw new Error("草稿盘点与正文不一致，请重试");
            if (
              !head.note?.currentVersionId &&
              (manifest.notes[questionId] ?? 0) > 0
            )
              throw new Error("云端草稿正文版本不可读取，请重试");
            if (stale()) return;
            await seedRecordFromServerHead(
              noteSession,
              { attemptId, questionId, phase: "scratch" },
              head,
              { strict: true },
            );
          },
          100,
        );
      }
      // 标画保持原底图与坐标，不重建背景，不拼接同纸笔迹。
      await recoverInBatches(needAnnotations, stale, async (questionId) => {
        const view = await fetchAnnotationViewApi(
          attemptId,
          questionId,
          "scratch",
        );
        if (stale()) return;
        await applyAnnotationView(
          annotationSession,
          { attemptId, questionId, phase: "scratch" },
          view,
        );
      });
      if (!stale()) setState(key, READY);
    } catch (cause) {
      if (!stale())
        setState(key, {
          state: "failed",
          message:
            cause instanceof Error ? cause.message : "作答材料恢复失败，请重试",
          ...(verified ? { verified: true as const } : {}),
        });
      throw cause;
    }
  })();
  tasks.set(key, task);
  void task.then(
    () => {
      if (tasks.get(key) === task) tasks.delete(key);
    },
    () => {
      if (tasks.get(key) === task) tasks.delete(key);
    },
  );
  return task;
}

/** 重入、聚焦、重新联网及定时下行恢复，和本机上传相互独立。 */
export function useAttemptMaterialRecovery(
  attemptId: string,
  questionIds: readonly string[],
): AttemptRecoveryState {
  const noteSession = useNoteSessionRef();
  const annotationSession = useAnnotationSessionRef();
  const signature = JSON.stringify(questionIds);
  useEffect(() => {
    if (!noteSession || !annotationSession) return;
    const ids: string[] = JSON.parse(signature);
    const refresh = () => {
      void recoverAttemptMaterials(attemptId, ids).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [attemptId, signature, noteSession, annotationSession]);
  return useSyncExternalStore(
    subscribeAttemptRecovery,
    () => getAttemptRecoveryState(attemptId),
    () => LOADING,
  );
}
