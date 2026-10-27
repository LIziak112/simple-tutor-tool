/**
 * 订正工作台（2026-10 订正重构）：结果页「订正」直达的全屏重做空间——
 * 「按照最初做题那样重新做一遍」：
 * - 题面 = 答题页同款 QuestionSurface 原样渲染（题干 + 选项 + 判断/填空
 *   控件形态，readOnly 中性呈现——不带本人答案与对错标记；结果视图
 *   snapshot.stemMd 已是 studentStemMd 投影，题目是什么就呈现什么）；
 * - 圈画与做题完全同款（2026-10-27 实测反馈三次定稿）：题面卡「圈画」
 *   按钮进入标画模式 → QuestionAnnotationOverlay 把透明画布直接叠在
 *   **原题**上落墨（题干 + 选项都可圈；底部标画工具栏，点「完成」退出）
 *   ——不用服务端装配的「仅题干底图」（不含选项、可能渲染不全），底图
 *   只作保存后的存证快照（导出/回看用），编辑期恒为活题面。已封存的
 *   上一份圈画原位只读展示（再点按钮提示已定格，无新行机制）；
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
  type AttemptQuestionPublic,
  type AttemptResultQuestion,
  NOTE_REFLECTION_MAX_LENGTH,
  type NoteHeadData,
  type QuestionPublic,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { CircleAlert, ClipboardEdit, Pencil } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  QuestionAnnotationOverlay,
  type QuestionAnnotationOverlayHandle,
} from "@/features/annotation/QuestionAnnotationOverlay";
import { sealCorrectionAnnotation } from "@/features/annotation/seal-correction-annotation";
import { useAnnotationRecord } from "@/features/annotation/use-annotation-record";
import {
  AttemptEditorNotice,
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/attempt/AttemptEditorContext";
import {
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
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

/**
 * 本地编辑器协调（AttemptEditorProvider 单题工作台实例）：圈画模式的
 * 收笔落盘/退出切换与「上次操作未完成」横幅复用答题页同一套机制。
 */
export function CorrectionWorkspace(props: CorrectionWorkspaceProps) {
  return (
    <AttemptEditorProvider>
      <CorrectionWorkspaceInner {...props} />
    </AttemptEditorProvider>
  );
}

function CorrectionWorkspaceInner({
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

  // ---- 圈画（与做题同款：QuestionAnnotationOverlay 原位直接在原题上落墨） ----
  const editor = useAttemptEditor(questionId);
  const annotationOverlay = useRef<QuestionAnnotationOverlayHandle>(null);
  const annotationRecord = useAnnotationRecord(
    attemptId,
    questionId,
    "correction",
  );
  const drawing =
    editor?.active?.questionId === questionId &&
    editor.active.kind === "annotation";
  const annotationCount = annotationRecord?.doc?.strokes.length ?? 0;
  const annotationProblem =
    annotationRecord?.conflict != null ||
    annotationRecord?.denied != null ||
    annotationRecord?.local === "failed";

  const snapshot = question.snapshot;
  /** 题面题目（QuestionPublic 形态；stemMd 为结果视图的 studentStemMd 投影） */
  const surfaceQuestion = useMemo<QuestionPublic>(
    () => ({
      id: snapshot.id,
      type: snapshot.type,
      difficulty: snapshot.difficulty,
      knowledge: snapshot.knowledge,
      stemMd: snapshot.stemMd,
      ...(snapshot.options !== undefined ? { options: snapshot.options } : {}),
      hintCount: snapshot.hintCount,
    }),
    [snapshot],
  );
  /**
   * 原位圈画身份（questionRevisionId = responses 行 id，服务端 POST base
   * 严格校验）：旧结果视图响应缺失时优雅降级——只渲染题面，不提供圈画。
   */
  const inlineQuestion = useMemo<AttemptQuestionPublic | null>(
    () =>
      question.questionRevisionId !== undefined
        ? {
            ...surfaceQuestion,
            questionRevisionId: question.questionRevisionId,
          }
        : null,
    [surfaceQuestion, question.questionRevisionId],
  );

  const toggleAnnotation = () => {
    if (drawing) void editor?.request(null);
    else void annotationOverlay.current?.start();
  };

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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 保存进行中/草稿纸全屏中不整层关闭：迟到的成败反馈与全屏作答
        // 不能被 Esc/遮罩误关（全屏退出由 NoteLayer 自己的退出按钮承接）
        if (sealing || paperFullscreen) return;
        // 圈画模式中 Esc/遮罩先退圈画（与答题页 Esc 同语义），再按一次才关工作台
        if (!open && drawing) {
          void editor?.request(null);
          return;
        }
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0"
        aria-describedby={undefined}
        // 与答题页题卡同语义：圈画模式中点圈画面/工具栏/草稿纸以外区域
        // 即收笔退出圈画（作答区照常操作不受影响）
        onPointerDownCapture={(event) => {
          if (
            editor?.getActive()?.kind !== "annotation" ||
            !(event.target instanceof Element) ||
            !event.currentTarget.contains(event.target)
          )
            return;
          if (
            event.target.closest(
              '[data-annotation-trigger], [data-slot="question-annotation-overlay"], [data-slot="attempt-bottom-bar"], [data-slot="note-layer"], [data-slot="handwritten-controls"]',
            )
          )
            return;
          void editor.request(null);
        }}
      >
        <DialogHeader className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ClipboardEdit aria-hidden className="size-4 text-primary" />
            订正 · 第 {questionNo} 题
          </DialogTitle>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
            {correctionName}
          </span>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {/* 编辑器切换的收笔落盘失败横幅（与答题页同一套协调机制） */}
          <AttemptEditorNotice />
          <div
            ref={rowRef}
            data-slot="correction-body-row"
            data-layout={layout}
            className="mx-auto flex w-full max-w-[1120px]"
            style={
              layout === "side" ? NOTE_SIDE_ROW_STYLE : NOTE_STACK_ROW_STYLE
            }
          >
            {/* 题面：答题页同款 QuestionSurface 原样渲染（中性 readOnly）；
                圈画按钮进入标画模式后画布直接叠在原题（题干+选项）上落墨 */}
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
                {inlineQuestion !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto h-11 min-w-11 gap-1.5 px-2"
                    title="圈画题干"
                    aria-label={`${ariaPrefix}圈画题干${drawing ? "（标画中）" : ""}${annotationCount > 0 ? `（已有 ${annotationCount} 笔）` : ""}${annotationProblem ? "，同步需处理" : ""}`}
                    aria-expanded={drawing}
                    data-annotation-trigger
                    onClick={toggleAnnotation}
                  >
                    {annotationProblem ? (
                      <CircleAlert
                        aria-hidden
                        className="size-4 text-amber-600"
                      />
                    ) : (
                      <Pencil
                        aria-hidden
                        className={`size-4 ${drawing || annotationCount > 0 ? "text-primary" : ""}`}
                      />
                    )}
                    <span className="hidden lg:inline">圈画</span>
                    {annotationCount > 0 && (
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-current"
                      />
                    )}
                  </Button>
                )}
              </div>
              {inlineQuestion !== null ? (
                <QuestionAnnotationOverlay
                  ref={annotationOverlay}
                  attemptId={attemptId}
                  question={inlineQuestion}
                  label={ariaPrefix}
                  phase="correction"
                >
                  <QuestionSurface question={inlineQuestion} readOnly />
                </QuestionAnnotationOverlay>
              ) : (
                // 旧结果视图响应无 questionRevisionId：题面照常，圈画不可用
                <QuestionSurface question={surfaceQuestion} readOnly />
              )}
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
