/**
 * 冲突裁决 / 被拒重试的动作接线（T6R.15 闸门修复 F4 抽取）：NoteLayer
 * （scratch 草稿纸）与 CorrectionPanel（订正编辑器）曾整段同构的
 * resolveError state + keepLocal/keepCloud/retryDenied 三回调的单一实现；
 * CorrectionSection 的补充稿同步状态块（闸门修复 F3）是第三个消费者。
 * scope 定在调用方（phase 三态 scratch/correction/supplement）；NoteLayer
 * 的图片维度逻辑（retryImages/imageRetrying）不在此 hook——留在 NoteLayer。
 */
import { useCallback, useRef, useState } from "react";
import type { NoteScope, NoteSessionRef } from "@/features/notes/note-store";
import {
  resolveNoteConflictKeepCloud,
  resolveNoteConflictKeepLocal,
  retryNoteUpload,
} from "@/features/notes/note-sync";

export interface NoteSyncActions {
  /** 冲突裁决动作的中文报错（渲染在冲突面板内） */
  resolveError: string | null;
  setResolveError: (error: string | null) => void;
  /** 冲突裁决：保留本机（对齐云端摘要后立即补传） */
  keepLocal: () => void;
  /** 冲突裁决：保留云端（拉云端稿为工作稿、清 pending） */
  keepCloud: () => void;
  /** denied(access) 手动重试（清终态并立即补传） */
  retryDenied: () => void;
}

/**
 * 一份笔记的冲突/被拒动作接线（scope 每渲染新对象亦安全——ref 模式取
 * 最新值；session 未绑定（standby）时三回调 no-op）。
 */
export function useNoteSyncActions(
  session: NoteSessionRef | null,
  scope: NoteScope,
): NoteSyncActions {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [resolveError, setResolveError] = useState<string | null>(null);
  const keepLocal = useCallback(() => {
    if (session === null) return;
    setResolveError(null);
    void resolveNoteConflictKeepLocal(session, scopeRef.current).catch(
      (err: unknown) => {
        setResolveError(err instanceof Error ? err.message : "操作失败");
      },
    );
  }, [session]);
  const keepCloud = useCallback(() => {
    if (session === null) return;
    setResolveError(null);
    void resolveNoteConflictKeepCloud(session, scopeRef.current).catch(
      (err: unknown) => {
        setResolveError(err instanceof Error ? err.message : "操作失败");
      },
    );
  }, [session]);
  const retryDenied = useCallback(() => {
    if (session === null) return;
    void retryNoteUpload(session, scopeRef.current);
  }, [session]);
  return { resolveError, setResolveError, keepLocal, keepCloud, retryDenied };
}
