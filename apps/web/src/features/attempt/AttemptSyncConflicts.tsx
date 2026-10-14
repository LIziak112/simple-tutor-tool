import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { getAnnotationView } from "@/features/annotation/annotation-store";
import {
  currentAnnotationSession,
  resolveAnnotationConflictKeepCloud,
  resolveAnnotationConflictKeepLocalAndUpload,
} from "@/features/annotation/annotation-sync";
import { getNoteView } from "@/features/notes/note-store";
import {
  currentNoteSession,
  resolveNoteConflictKeepCloud,
  resolveNoteConflictKeepLocal,
} from "@/features/notes/note-sync";
import { draftStore, getDraftSessionEpoch } from "./draft-store";
import { subscribeAttemptSaveChanges } from "./use-attempt-save-status";
import type { DraftSyncApi } from "./use-draft-sync";

type Conflict = {
  questionId: string;
  questionNo: number;
  kind: "答案" | "草稿" | "标画";
};
/** 裁决以题目和材料为单位，不覆盖其它设备已完成的题目。 */
export function AttemptSyncConflicts({
  attemptId,
  questionIds,
  sync,
  beforeResolve,
}: {
  attemptId: string;
  questionIds: readonly string[];
  sync: DraftSyncApi;
  beforeResolve: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(subscribeAttemptSaveChanges, () => {
    const notes = currentNoteSession();
    const annotations = currentAnnotationSession();
    const rows: Conflict[] = [];
    questionIds.forEach((questionId, index) => {
      const scope = { attemptId, questionId, phase: "scratch" as const };
      const add = (kind: Conflict["kind"]) =>
        rows.push({ questionId, questionNo: index + 1, kind });
      if (draftStore.peekAnswerConflicts(attemptId)[questionId]) add("答案");
      if (notes && getNoteView(notes, scope)?.server === "conflict")
        add("草稿");
      if (
        annotations &&
        getAnnotationView(annotations, scope)?.server === "conflict"
      )
        add("标画");
    });
    return JSON.stringify(rows);
  });
  const conflicts: Conflict[] = JSON.parse(snapshot);
  if (!conflicts.length) return null;
  const resolve = async (row: Conflict, keep: "local" | "cloud") => {
    setBusy(true);
    setError(null);
    try {
      const epoch = getDraftSessionEpoch();
      const mutationId = draftStore.answerMutationId(attemptId, row.questionId);
      if (!(await beforeResolve()))
        throw new Error("请先完成当前笔迹的本机保存");
      if (epoch !== getDraftSessionEpoch())
        throw new Error("账号已切换，请重新进入作答页");
      const scope = {
        attemptId,
        questionId: row.questionId,
        phase: "scratch" as const,
      };
      if (row.kind === "答案") {
        if (
          mutationId !== draftStore.answerMutationId(attemptId, row.questionId)
        )
          throw new Error("裁决期间答案已修改，请重新选择");
        await draftStore.resolveAnswerConflict(attemptId, row.questionId, keep);
        if (keep === "local") await sync.syncNow();
      } else if (row.kind === "草稿") {
        const session = currentNoteSession();
        if (!session) throw new Error("草稿会话尚未就绪");
        await (keep === "local"
          ? resolveNoteConflictKeepLocal(session, scope)
          : resolveNoteConflictKeepCloud(session, scope));
      } else {
        const session = currentAnnotationSession();
        if (!session) throw new Error("标画会话尚未就绪");
        await (keep === "local"
          ? resolveAnnotationConflictKeepLocalAndUpload(session, scope)
          : resolveAnnotationConflictKeepCloud(session, scope));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步裁决失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="同步冲突"
      className="rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm">
        以下内容在当前设备与云端都有修改。请选择本题要保留的版本，其它题目会自动合并。
      </p>
      {conflicts.map((row) => (
        <div
          key={`${row.questionId}:${row.kind}`}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <span>
            第 {row.questionNo} 题 · {row.kind}
          </span>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void resolve(row, "local")}
          >
            保留当前设备版本
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void resolve(row, "cloud")}
          >
            采用云端版本
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
