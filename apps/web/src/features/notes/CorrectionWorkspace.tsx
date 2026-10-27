/**
 * 订正工作台（2026-10 订正重构）：结果页「订正」直达的全屏重做空间——
 * 「按照最初做题那样重新做一遍」：
 * - 单独显示本题题面（公开投影快照：题干 + 选项**中性呈现**——不带对错
 *   判定、本人答案与参考答案标记，重做时先不被答案干扰；交卷已公布的
 *   结果材料仍在结果页对照）；
 * - 圈画：AnnotationLayer(phase=correction) 内嵌（独立「添加订正标画」入口
 *   已移除；已封存的上一份圈画转只读，草稿纸照常重做）；
 * - 草稿纸：use-note-editor(phase='correction') + NoteToolbar + InkPad，
 *   与答题草稿同一套手感与同步管线（订正复用草稿功能）；
 * - 「保存订正」= 一层检查点：确认弹层可选反思（我卡在哪里/我的错因，
 *   ≤NOTE_REFLECTION_MAX_LENGTH）→ 先封存订正草稿（catchUpNotes → record
 *   检查 → sealCorrectionApi CAS），再封存订正圈画（sealCorrectionAnnotation；
 *   失败不回滚草稿检查点，仅提示圈画保留可编辑）；命名自动：工作台顶部
 *   徽章 = 轮次（roundLabel）+ 第 N 次订正（N=已封存数+进行中这一份），
 *   用户不命名；
 * - 封存后行不再接受写入——再编辑由服务端 409 NOTE_CORRECTION_SEALED +
 *   note-sync 自动「新开一行」重置承接（下一次订正重开工作台即可）。
 */

import {
  type AttemptResultQuestion,
  lettersOf,
  NOTE_REFLECTION_MAX_LENGTH,
  type NoteHeadData,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { ClipboardEdit, PenLine } from "lucide-react";
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
import { AnnotationLayer } from "@/features/annotation/AnnotationLayer";
import { sealCorrectionAnnotation } from "@/features/annotation/seal-correction-annotation";
import {
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { InkPad } from "@/features/ink/InkPad";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
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

export interface CorrectionWorkspaceProps {
  attemptId: string;
  questionId: string;
  /** 卷内题号（1 起，标题与 aria 用） */
  questionNo: number;
  /** 无障碍标签前缀（如「第 3 题」） */
  ariaPrefix?: string;
  /** 轮次标注（attemptRoundLabel 产物；null 只显示第 N 次订正） */
  roundLabel?: string | null;
  /** 自动命名的订正序号（进行中这份是第几次订正） */
  correctionNo: number;
  /** 结果页题目快照（公开投影——题干/选项；不读答案与判定字段） */
  question: AttemptResultQuestion;
  /** 关闭工作台（回到结果页；未封存内容保留「继续订正」） */
  onClose: () => void;
  /** 封存成功（携带 seal 响应 head）——订正入口据此刷新缓存与按钮态 */
  onSealed: (head: NoteHeadData) => void;
}

export function CorrectionWorkspace({
  attemptId,
  questionId,
  questionNo,
  ariaPrefix = "本题",
  roundLabel = null,
  correctionNo,
  question,
  onClose,
  onSealed,
}: CorrectionWorkspaceProps) {
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

  // ---- 冲突裁决 / 被拒重试（共享 hook useNoteSyncActions） ----
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

  // ---- 保存订正（一层检查点：草稿 + 圈画 + 反思） ----
  const [sealOpen, setSealOpen] = useState(false);
  const [stuckAt, setStuckAt] = useState("");
  const [errorCause, setErrorCause] = useState("");
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  /**
   * 草稿检查点已保存但圈画封存失败（部分成功）：弹窗留在原地展示结果，
   * 「知道了」再关闭——不能静默吞掉圈画未定格的事实，也不能因此关不掉。
   */
  const [partialSealedHead, setPartialSealedHead] =
    useState<NoteHeadData | null>(null);

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
        setSealError("还没有订正内容，请先在草稿纸上书写再保存。");
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
        setSealError("还没有订正内容，请先在草稿纸上书写再保存。");
        return;
      }
      const head = await sealCorrectionApi(attemptId, questionId, {
        baseRevision: record.baseRevision,
        ...(stuckAt.trim() !== "" ? { stuckAt: stuckAt.trim() } : {}),
        ...(errorCause.trim() !== "" ? { errorCause: errorCause.trim() } : {}),
      });
      // 圈画检查点：有圈画正文才封存（无圈画返回 0 不算错误）；失败不回滚
      // 草稿检查点——留在弹窗提示，圈画保留可编辑，下次保存订正时再尝试
      try {
        await sealCorrectionAnnotation({ attemptId, questionId });
      } catch {
        setPartialSealedHead(head);
        return;
      }
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
  const snapshot = question.snapshot;
  const correctionName =
    roundLabel !== null
      ? `${roundLabel} · 第 ${correctionNo} 次订正`
      : `第 ${correctionNo} 次订正`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ClipboardEdit aria-hidden className="size-4 text-primary" />
            订正 · 第 {questionNo} 题
          </DialogTitle>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
            {correctionName}
          </span>
          {strokeCount > 0 && (
            <span className="text-xs text-muted-foreground">
              草稿 {strokeCount} 笔
            </span>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {/* 题面：公开投影中性呈现（无对错/答案标记——重做先不被答案干扰） */}
            <section
              aria-label={`${ariaPrefix}订正题面`}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 text-card-foreground"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[snapshot.type]}`}
                >
                  {QUESTION_TYPE_LABELS[snapshot.type]}
                </span>
                <span
                  role="img"
                  className="text-xs text-amber-500"
                  aria-label={`难度 ${snapshot.difficulty} 星`}
                >
                  {"★".repeat(snapshot.difficulty)}
                  <span className="text-muted-foreground/60">
                    {"★".repeat(5 - snapshot.difficulty)}
                  </span>
                </span>
                {snapshot.knowledge.map((name) => (
                  <span
                    key={name}
                    className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </div>
              <RichMarkdown
                source={displayStemMd(snapshot)}
                className="text-base"
              />
              {snapshot.options !== undefined && (
                <ol className="flex flex-col gap-1.5" aria-label="选项">
                  {snapshot.options.map((option, index) => (
                    <li
                      key={option}
                      className="flex min-h-11 items-start gap-2 rounded-lg border border-transparent px-3 py-2 text-sm"
                    >
                      <span className="mt-0.5 w-5 shrink-0 font-semibold">
                        {lettersOf(index)}
                      </span>
                      <RichMarkdown
                        source={option}
                        className="min-w-0 flex-1 text-base [&_p]:my-0"
                      />
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* 圈画题干（订正期；上一份已封存时只读展示） */}
            <section
              aria-label={`${ariaPrefix}订正圈画`}
              className="flex flex-col gap-2"
            >
              <AnnotationLayer
                attemptId={attemptId}
                questionId={questionId}
                phase="correction"
                ariaPrefix={ariaPrefix}
                triggerLabel="圈画题干"
              />
            </section>

            {/* 草稿纸：与答题草稿同一套手感与同步管线 */}
            <section
              aria-label={`${ariaPrefix}订正草稿纸`}
              className="flex flex-col gap-2"
            >
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <PenLine aria-hidden className="size-4" />
                草稿纸
                <span className="font-normal text-muted-foreground">
                  在草稿纸上重新做一遍
                </span>
              </p>
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
                clearLabel="清空订正草稿"
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
                    正在打开订正草稿纸…
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
            </section>
          </div>
        </div>

        <footer className="border-t border-border bg-card px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+12px)] sm:px-5">
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
            <Button
              type="button"
              className="min-h-11"
              disabled={sealing}
              onClick={openSealDialog}
            >
              保存订正
            </Button>
            <p className="text-xs text-muted-foreground">
              保存后定格为一次订正（{correctionName}），并记录你的错因反思
            </p>
          </div>
        </footer>
      </DialogContent>

      {/* 清空二次确认 */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空订正草稿？</DialogTitle>
            <DialogDescription>
              将清除本题订正草稿的全部笔迹，清空后可用「撤销」恢复；已同步到
              服务端的旧版本不受影响。
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

      {/* 保存订正 = 一层检查点（反思 + 定格确认；圈画随同一并封存） */}
      <Dialog open={sealOpen} onOpenChange={setSealOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存订正</DialogTitle>
            <DialogDescription>
              保存后定格为「{correctionName}」，再修改会新开一份。顺手写下
              反思（可不填），帮自己看清卡点与错因。
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
            {partialSealedHead !== null && (
              <p
                role="status"
                className="text-sm text-amber-700 dark:text-amber-400"
              >
                订正已保存为「{correctionName}」；但订正圈画还没同步完成，
                暂未一并定格。圈画会保留可编辑，网络恢复后再保存一次订正即可。
              </p>
            )}
          </div>
          <DialogFooter>
            {partialSealedHead === null ? (
              <>
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
              </>
            ) : (
              <Button
                type="button"
                className="h-11"
                onClick={() => {
                  const head = partialSealedHead;
                  setSealOpen(false);
                  onSealed(head);
                }}
              >
                知道了
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
