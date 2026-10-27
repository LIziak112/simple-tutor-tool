/**
 * 订正工作台（2026-10 订正重构）：结果页「订正」直达的全屏重做空间——
 * 「按照最初做题那样重新做一遍」：
 * - 题面（公开投影快照：题干 + 选项**中性呈现**——不带对错判定、本人答案
 *   与参考答案标记，重做时先不被答案干扰；交卷已公布的结果材料仍在结果页
 *   对照）。题面即圈画面：AnnotationLayer 内嵌形态（embedded）挂载即走底图
 *   流——未就绪/禁用/出错时渲染活题面（RichMarkdown）+ 状态，底图（题干
 *   栅格，含选项）ready 后与画布接管题干显示，直接在题干上落墨（2026-10
 *   实测反馈：独立「圈画题干」折叠区已移除）；已封存的上一份圈画转只读；
 * - 草稿纸：直接挂答题页同款 NoteLayer（phase=correction）——同一套手感、
 *   触底自动加高、全屏、布局偏好（左右分栏/上下排列，note-layout 同源）、
 *   收起保活与同步状态（2026-10 实测反馈：「弹出页与习题的草稿一致」，
 *   不再另写一套）；工作台按同一套布局常量排双列（1120px 宽行，题面 55% /
 *   草稿 45%，窄屏自动上下排）；
 * - 「保存订正」= 一层检查点：确认弹层可选反思（我卡在哪里/我的错因，
 *   ≤NOTE_REFLECTION_MAX_LENGTH）→ 先封存订正草稿（catchUpNotes → record
 *   检查 → sealCorrectionApi CAS），再封存订正圈画（sealCorrectionAnnotation；
 *   失败不回滚草稿检查点，仅提示圈画保留可编辑）；命名自动：工作台顶部
 *   徽章 = 轮次（roundLabel）+ 第 N 次订正（N=已封存数+进行中这一份），
 *   用户不命名；
 * - 封存后行不再接受写入——再编辑由服务端 409 NOTE_CORRECTION_SEALED +
 *   note-sync 自动「新开一行」重置承接（下一次订正重开工作台即可）。
 * - 关闭工作台即卸载编辑器（与离开答题页同口径）：收笔落定的笔画均已
 *   writeNoteDoc 本机落盘；收笔瞬间的在途一笔与页面导航同样不可恢复
 *   （45 秒保活仅覆盖答题页收起场景，见 docs/约定/手写与同步）。
 */

import {
  type AttemptResultQuestion,
  lettersOf,
  NOTE_REFLECTION_MAX_LENGTH,
  type NoteHeadData,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
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
import { AnnotationLayer } from "@/features/annotation/AnnotationLayer";
import { sealCorrectionAnnotation } from "@/features/annotation/seal-correction-annotation";
import {
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { NoteLayer } from "@/features/notes/NoteLayer";
import {
  effectiveNoteLayout,
  NOTE_PAPER_COLUMN_STYLE,
  NOTE_QUESTION_COLUMN_STYLE,
  NOTE_SIDE_ROW_STYLE,
  NOTE_STACK_ROW_STYLE,
  useNoteLayoutPreference,
  useNoteSideUsable,
} from "@/features/notes/note-layout";
import { getNoteRecord } from "@/features/notes/note-store";
import { catchUpNotes } from "@/features/notes/note-sync";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
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

  // ---- 草稿纸开合与全屏（NoteLayer 受控；全屏期间拦外层关闭） ----
  const [noteOpen, setNoteOpen] = useState(true);
  const [paperFullscreen, setPaperFullscreen] = useState(false);

  // ---- 布局（与答题页同源：note-layout 偏好 + 两列可用宽度判定） ----
  const rowRef = useRef<HTMLDivElement>(null);
  const layoutPreference = useNoteLayoutPreference();
  const sideUsable = useNoteSideUsable(rowRef, layoutPreference === "auto");
  const layout = noteOpen
    ? effectiveNoteLayout(layoutPreference, sideUsable)
    : "below";

  // ---- 保存订正（一层检查点：草稿 + 圈画 + 反思） ----
  const [sealOpen, setSealOpen] = useState(false);
  const [stuckAt, setStuckAt] = useState("");
  const [errorCause, setErrorCause] = useState("");
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  /**
   * 草稿检查点已保存但圈画封存失败（部分成功）：弹窗留在原地展示结果与
   * 具体原因，可就地「重试圈画封存」（只补圈画，不再封存草稿），「知道了」
   * /X/Esc 关闭——不能静默吞掉圈画未定格的事实，也不能因此关不掉。
   */
  const [partialSealedHead, setPartialSealedHead] =
    useState<NoteHeadData | null>(null);
  /** 部分成功的具体原因（sealCorrectionAnnotation 抛出的中文错误，就地展示） */
  const [partialDetail, setPartialDetail] = useState<string | null>(null);
  /**
   * 本工作台会话内已成功的草稿封存（含部分成功）：行已定格，重试只补圈画
   * ——再次 sealCorrectionApi 必 409，跳过。
   */
  const sealedHeadRef = useRef<NoteHeadData | null>(null);

  const openSealDialog = () => {
    setSealError(null);
    setPartialSealedHead(null);
    setPartialDetail(null);
    setSealOpen(true);
  };

  const seal = useCallback(async () => {
    if (session === null) return;
    setSealing(true);
    setSealError(null);
    try {
      let head = sealedHeadRef.current;
      if (head === null) {
        // 先追平：本地落盘 → 上传队列 → 回执落地（seal 的 CAS 基线取追平后的
        // 本地 baseRevision——权威判定以 record 状态为准，不采样摘要）
        await catchUpNotes(attemptId);
        let record: Awaited<ReturnType<typeof getNoteRecord>>;
        try {
          // strictRead：读取失败≠无稿（硬性规则 6）——不得把 IDB 读错静默
          // 报成「还没有订正内容」
          record = await getNoteRecord(
            session,
            {
              attemptId,
              questionId,
              phase: "correction",
            },
            { strictRead: true },
          );
        } catch {
          setSealError("订正数据读取失败，请稍后重试");
          return;
        }
        if (record === null) {
          setSealError("还没有订正内容，请先在草稿纸上书写再保存。");
          return;
        }
        if (record.conflict !== null) {
          setSealError(
            "订正内容有同步冲突待处理，请先在草稿纸的同步面板选择保留哪一份。",
          );
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
        head = await sealCorrectionApi(attemptId, questionId, {
          baseRevision: record.baseRevision,
          ...(stuckAt.trim() !== "" ? { stuckAt: stuckAt.trim() } : {}),
          ...(errorCause.trim() !== ""
            ? { errorCause: errorCause.trim() }
            : {}),
        });
        sealedHeadRef.current = head;
      }
      // 圈画检查点：有圈画正文才封存（无圈画返回 0 不算错误）；失败不回滚
      // 草稿检查点——留在弹窗提示具体原因，可就地重试或稍后再说
      try {
        await sealCorrectionAnnotation({ attemptId, questionId });
      } catch (err) {
        setPartialSealedHead(head);
        setPartialDetail(
          err instanceof Error ? err.message : "圈画封存失败，请稍后重试",
        );
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

  const correctionName =
    roundLabel !== null
      ? `${roundLabel} · 第 ${correctionNo} 次订正`
      : `第 ${correctionNo} 次订正`;

  const snapshot = question.snapshot;
  /** 活题面回退（底图未就绪/禁用/出错时的中性呈现——题干任一刻可读） */
  const stemFallback = (
    <div className="flex flex-col gap-3">
      <RichMarkdown source={displayStemMd(snapshot)} className="text-base" />
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
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 保存进行中/草稿纸全屏中不整层关闭：迟到的成败反馈与全屏作答
        // 不能被 Esc/遮罩误关（全屏退出由 NoteLayer 自己的退出按钮承接）
        if (sealing || paperFullscreen) return;
        if (!open) onClose();
      }}
    >
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
          <span className="text-xs text-muted-foreground">
            题干可直接圈画，重做写在草稿纸上
          </span>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <div
            ref={rowRef}
            data-slot="correction-body-row"
            data-layout={layout}
            className="mx-auto flex w-full max-w-[1120px]"
            style={
              layout === "side" ? NOTE_SIDE_ROW_STYLE : NOTE_STACK_ROW_STYLE
            }
          >
            {/* 题面：公开投影中性呈现（无对错/答案标记）+ 直接圈画
                （内嵌标注层：底图就绪后题面即圈画面，不再是独立折叠区） */}
            <section
              aria-label={`${ariaPrefix}订正题面`}
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 text-card-foreground"
              style={layout === "side" ? NOTE_QUESTION_COLUMN_STYLE : undefined}
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
              <AnnotationLayer
                attemptId={attemptId}
                questionId={questionId}
                phase="correction"
                ariaPrefix={ariaPrefix}
                embedded
                fallback={stemFallback}
              />
            </section>

            {/* 草稿纸：答题页同款 NoteLayer（phase=correction——同一套
                手感/自动加高/全屏/布局偏好/保活/同步状态） */}
            <div
              className="min-w-0"
              style={layout === "side" ? NOTE_PAPER_COLUMN_STYLE : undefined}
            >
              <NoteLayer
                attemptId={attemptId}
                questionId={questionId}
                phase="correction"
                ariaPrefix={ariaPrefix}
                open={noteOpen}
                onOpenChange={setNoteOpen}
                onFullscreenChange={setPaperFullscreen}
                stemMd={displayStemMd(snapshot)}
                options={snapshot.options}
              />
            </div>
          </div>
        </div>

        <footer className="border-t border-border bg-card px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+12px)] sm:px-5">
          <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-2">
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

      {/* 保存订正 = 一层检查点（反思 + 定格确认；圈画随同一并封存） */}
      <Dialog
        open={sealOpen}
        onOpenChange={(open) => {
          if (sealing) return; // 保存进行中不关弹层（在途结果仍会落地）
          if (!open && partialSealedHead !== null) {
            // 部分成功态的 X/Esc 等价「知道了」：订正已封存，head 缓存必须
            // 更新——否则按钮恒显「继续订正」、计数不 +1
            const head = partialSealedHead;
            setSealOpen(false);
            onSealed(head);
            return;
          }
          setSealOpen(open);
        }}
      >
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
                className="min-h-22 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
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
                className="min-h-22 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
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
              <div
                role="status"
                className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-400"
              >
                <p>
                  订正已保存为「{correctionName}」；但订正圈画暂未一并定格。
                </p>
                {partialDetail !== null && <p>{partialDetail}</p>}
                <p className="text-xs text-muted-foreground">
                  圈画会保留可编辑：可立即重试圈画封存；若提示冲突/被拒，请先
                  按题面圈画区的指引处理后再试。
                </p>
              </div>
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
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={sealing}
                  onClick={() => void seal()}
                >
                  {sealing ? "正在重试…" : "重试圈画封存"}
                </Button>
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
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
