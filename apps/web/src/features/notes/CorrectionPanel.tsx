/**
 * 订正编辑器（T6R.15 C，CorrectionSection 的编辑形态）：use-note-editor
 * (phase='correction') + NoteToolbar + InkPad 纸面 + 四维状态区（共享
 * NoteStatusArea，图片维度关——订正行不在任何 head 图片投影里，查看走
 * 本地确定性渲染）。「保存订正」= seal 检查点（D2）：可选反思两输入
 * （≤NOTE_REFLECTION_MAX_LENGTH，契约常量单源）+ 确认提示「保存后这份
 * 订正定格，再修改会新开一份」；确认后先 catchUpNotes 追平（本地落盘 +
 * 上传队列 + 回执落地）再按本地 baseRevision 封存（CAS；0 = 尚无内容拒
 * 并提示先书写）。封存后行不再接受写入——再编辑由服务端 409
 * NOTE_CORRECTION_SEALED + note-sync 自动「新开一行」重置承接。
 */

import { NOTE_REFLECTION_MAX_LENGTH, type NoteHeadData } from "@tutor/contract";
import { ClipboardEdit } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InkPad } from "@/features/ink/InkPad";
import { NoteStatusArea } from "@/features/notes/NoteStatusArea";
import { NoteToolbar } from "@/features/notes/NoteToolbar";
import { getNoteRecord } from "@/features/notes/note-store";
import { catchUpNotes } from "@/features/notes/note-sync";
import {
  EMPTY_NOTE_DOC,
  inkDocOf,
  useNoteEditor,
} from "@/features/notes/use-note-editor";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { useNoteSyncActions } from "@/features/notes/use-note-sync-actions";
import { sealCorrectionApi } from "@/lib/api";

/** 反思输入按契约上限截断（jsdom 程序赋值绕过 maxLength，双保险） */
function clampReflection(value: string): string {
  return value.slice(0, NOTE_REFLECTION_MAX_LENGTH);
}

export interface CorrectionPanelProps {
  attemptId: string;
  questionId: string;
  /** 无障碍标签前缀（如「第 3 题」），拼入收起按钮等 aria */
  ariaPrefix?: string;
  /** 关闭编辑器（回到订正区列表形态） */
  onClose: () => void;
  /** 封存成功（携带 seal 响应 head）——订正区据此刷新列表 */
  onSealed: (head: NoteHeadData) => void;
}

export function CorrectionPanel({
  attemptId,
  questionId,
  ariaPrefix = "本题",
  onClose,
  onSealed,
}: CorrectionPanelProps) {
  const session = useNoteSessionRef();
  const editor = useNoteEditor({
    session,
    attemptId,
    questionId,
    phase: "correction",
    active: true,
  });
  const { view } = editor;
  const doc = view?.doc ?? null;
  const strokeCount = doc?.ink.strokes.length ?? 0;

  // ---- 冲突裁决 / 被拒重试（共享 hook useNoteSyncActions，scope 定在
  // correction）；seal 的 CAS 基线读取仍用本组件的 scopeRef ----
  const scopeRef = useRef({
    attemptId,
    questionId,
    phase: "correction" as const,
  });
  scopeRef.current = { attemptId, questionId, phase: "correction" as const };
  const { resolveError, keepLocal, keepCloud, retryDenied } =
    useNoteSyncActions(session, scopeRef.current);

  // ---- 清空二次确认（清空=空稿作为新正文版本保存，覆盖语义同草稿纸） ----
  const [clearOpen, setClearOpen] = useState(false);

  // ---- 保存订正（seal 检查点） ----
  const [sealOpen, setSealOpen] = useState(false);
  const [stuckAt, setStuckAt] = useState("");
  const [errorCause, setErrorCause] = useState("");
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);

  const openSealDialog = () => {
    setSealError(null);
    setSealOpen(true);
  };

  const seal = useCallback(async () => {
    if (session === null) return;
    setSealing(true);
    setSealError(null);
    try {
      // 先追平：本地落盘 → 上传队列 → 回执落地（seal 的 CAS 基线取追平后的
      // 本地 baseRevision——权威判定以 record 状态为准，不采样摘要）
      await catchUpNotes(attemptId);
      const record = await getNoteRecord(session, scopeRef.current);
      if (record === null) {
        setSealError("还没有订正内容，请先书写再保存。");
        return;
      }
      if (record.conflict !== null) {
        setSealError("订正内容有同步冲突待处理，请先在上方选择保留哪一份。");
        return;
      }
      if (record.denied !== null) {
        setSealError(`订正同步被拒：${record.denied.reason}`);
        return;
      }
      if (record.pending !== null) {
        setSealError("订正的最新修改还没同步完成，请稍候再试。");
        return;
      }
      if (record.baseRevision === 0) {
        setSealError("还没有订正内容，请先书写再保存。");
        return;
      }
      const head = await sealCorrectionApi(attemptId, questionId, {
        baseRevision: record.baseRevision,
        ...(stuckAt.trim() !== "" ? { stuckAt: stuckAt.trim() } : {}),
        ...(errorCause.trim() !== "" ? { errorCause: errorCause.trim() } : {}),
      });
      setSealOpen(false);
      onSealed(head);
    } catch (err) {
      setSealError(
        err instanceof Error ? err.message : "保存订正失败，请稍后重试",
      );
    } finally {
      setSealing(false);
    }
  }, [session, attemptId, questionId, stuckAt, errorCause, onSealed]);

  const label = `${ariaPrefix}订正`;

  return (
    <div
      data-slot="correction-panel"
      className="flex flex-col gap-2 rounded-2xl border border-primary/40 bg-card p-3 text-card-foreground"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <ClipboardEdit aria-hidden className="size-4" />
          订正
          {strokeCount > 0 && (
            <span className="font-normal text-muted-foreground">
              {strokeCount} 笔
            </span>
          )}
        </p>
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-2.5"
          aria-label={`收起${label}`}
          onClick={onClose}
        >
          收起
        </Button>
      </div>

      <NoteToolbar
        label={label}
        tool={editor.tool}
        onToolChange={editor.setTool}
        penColor={editor.penColor}
        onPenColorChange={editor.setPenColor}
        penSize={editor.penSize}
        onPenSizeChange={editor.setPenSize}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={() => editor.engineRef.current?.undo()}
        onRedo={() => editor.engineRef.current?.redo()}
        onClearRequest={() => setClearOpen(true)}
        clearLabel="清空订正"
      />

      <div
        ref={editor.paperWrapRef}
        data-slot="correction-paper"
        className="w-full"
      >
        {editor.localLoaded ? (
          <InkPad
            engine="atrament"
            showToolbar={false}
            inputMode="session"
            label={label}
            engineRef={editor.engineRef}
            background={doc?.background ?? "grid"}
            paperHeight={editor.cssHeight}
            initial={inkDocOf(doc ?? EMPTY_NOTE_DOC)}
            onDocChange={editor.handleDocChange}
            onEngineRebuild={editor.onEngineRebuild}
          />
        ) : (
          <div
            role="status"
            className="flex h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
          >
            正在打开订正…
          </div>
        )}
      </div>

      <NoteStatusArea
        view={view}
        localLoaded={editor.localLoaded}
        label="订正"
        images={false}
        resolveError={resolveError}
        onKeepLocal={keepLocal}
        onKeepCloud={keepCloud}
        onRetryDenied={retryDenied}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="min-h-11"
          disabled={sealing}
          onClick={openSealDialog}
        >
          保存订正
        </Button>
        <p className="text-xs text-muted-foreground">
          保存后这份订正定格，再修改会新开一份
        </p>
      </div>

      {/* 清空二次确认 */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空订正？</DialogTitle>
            <DialogDescription>
              将清除本题订正的全部笔迹，清空后可用「撤销」恢复；已同步到服务端
              的旧版本不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setClearOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              onClick={() => {
                editor.engineRef.current?.clear();
                setClearOpen(false);
              }}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 保存订正 = seal 检查点（可选反思 + 定格确认） */}
      <Dialog open={sealOpen} onOpenChange={setSealOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存订正</DialogTitle>
            <DialogDescription>
              保存后这份订正定格，再修改会新开一份。可以顺手写下反思（可不填），
              帮自己看清卡点与错因。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="correction-reflection-stuck"
                className="text-sm font-medium"
              >
                我卡在哪里
              </label>
              <textarea
                id="correction-reflection-stuck"
                rows={3}
                className="min-h-22 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                placeholder="比如：第二问不知道该设哪个未知数"
                value={stuckAt}
                maxLength={NOTE_REFLECTION_MAX_LENGTH}
                onChange={(e) => setStuckAt(clampReflection(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                最多 {NOTE_REFLECTION_MAX_LENGTH} 字
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="correction-reflection-cause"
                className="text-sm font-medium"
              >
                我的错因
              </label>
              <textarea
                id="correction-reflection-cause"
                rows={3}
                className="min-h-22 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                placeholder="比如：去括号时忘了变号"
                value={errorCause}
                maxLength={NOTE_REFLECTION_MAX_LENGTH}
                onChange={(e) => setErrorCause(clampReflection(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                最多 {NOTE_REFLECTION_MAX_LENGTH} 字
              </p>
            </div>
            {sealError !== null && (
              <p role="alert" className="text-sm text-destructive">
                {sealError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={sealing}
              onClick={() => setSealOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-11"
              disabled={sealing}
              onClick={() => void seal()}
            >
              {sealing ? "正在保存…" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
