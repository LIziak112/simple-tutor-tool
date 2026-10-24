import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  StudentAnswer,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { memo, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AttemptQuestionCard } from "@/features/attempt/AttemptQuestionCard";
import {
  ResultOptions,
  VerdictBadge,
} from "@/features/attempt/AttemptResultView";
import {
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { ResultAnswerComparison } from "@/features/attempt/ResultAnswerComparison";
import { SelfReviewSection } from "@/features/attempt/SelfReviewSection";
import {
  busyCloseGuard,
  DraftProblemAlert,
} from "@/features/attempt/SubmitConfirmDialog";
import { verdictBadgeDisplayOf } from "@/features/attempt/self-review-display";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import type {
  LessonQuestionHandlers,
  LessonSubmitOutcome,
} from "./use-lesson-attempt";

/**
 * 讲练页题卡（2026-10 讲练一体）：讲义段落间的可作答题卡。
 * - 作答态（未提交）：题干投影（QuestionSurface）+ 按题型作答（客观题控件在
 *   QuestionSurface 内、手写题 HandwrittenControls 内含最终答案输入）+
 *   分步提示（HintPanel）+「显示答案」（一键直达，教师演示场景：不弹确认
 *   层、未作答不警示，直接按当前作答判定并释放答案与解析；触控 ≥44px）；
 * - 结果态（点过显示答案，当题释放）：对错徽章（finalCorrect 优先，null=
 *   无自动判定则不显示）+ 题干快照与选项标记 + 参考答案（ResultAnswerComparison）
 *   + 解析直接展示（教师演示：不折叠）；
 * - 只读防御态：既未提交又无作答回调（异常数据形态）——提示刷新。
 * 作答链路全部经 handlers 复用答题页既有 hook（use-lesson-attempt 单一出处）；
 * 「显示答案」底层仍走服务端单题提交判分（防泄露与判分在服务端的硬规则不变）。
 */

/** 显示答案兜底弹层的阶段（一次 set 完成迁移，无中间组合态） */
type RevealPhase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "choice"; reason: string }
  | { kind: "error"; message: string };

/**
 * 显示答案兜底弹层：仅两种场景出现——
 * 1) 草稿未保存完整（problems）：复用整卷 T6R.10 的缺稿明确选择语义（缺稿
 *    继续须用户明确点击，不静默放行）；
 * 2) stale / error：如实展示原因，关闭后可再点「显示答案」重试。
 * busy（缺稿确认后的重交进行中）封堵关闭路径（与 SubmitConfirmDialog 同纪律）。
 */
function LessonRevealDialog({
  open,
  phase,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  phase: RevealPhase;
  onCancel: () => void;
  onConfirm: (allowMissing: boolean) => void;
}) {
  const busy = phase.kind === "busy";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent
        className="flex max-h-[min(80dvh,640px)] w-[calc(100%-24px)] flex-col"
        aria-describedby="lesson-reveal-desc"
        closeDisabled={busy}
        // busy 封堵与整卷 SubmitConfirmDialog 同源（单一出处）
        {...busyCloseGuard(busy)}
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === "error" ? "显示答案失败" : "草稿未保存完整"}
          </DialogTitle>
          <DialogDescription
            id="lesson-reveal-desc"
            className="text-sm leading-6"
          >
            {phase.kind === "error"
              ? "请稍后重试；若持续失败，可刷新页面。"
              : "这道题的草稿还没有同步完整，请选择如何继续。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-1 -m-1">
          {phase.kind === "choice" && (
            <DraftProblemAlert
              title="这道题的草稿未保存完整："
              footnote="可以返回稍等同步完成；或明确选择继续——草稿将标记为「未保存」， 之后找回的内容只能作为补充材料。"
            >
              <p className="mt-1 text-muted-foreground">{phase.reason}</p>
            </DraftProblemAlert>
          )}
          {phase.kind === "error" && (
            <p role="alert" className="text-xs text-destructive">
              {phase.message}
            </p>
          )}
          {busy && (
            <p className="text-xs text-muted-foreground">
              正在同步草稿并显示答案，请稍候…
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border pt-4">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onCancel}
            disabled={busy}
          >
            {phase.kind === "error" ? "关闭" : "返回作答"}
          </Button>
          {phase.kind === "choice" && (
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => onConfirm(true)}
              disabled={busy}
            >
              {busy ? "正在显示…" : "显示答案，草稿未保存完整"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface LessonQuestionCardProps {
  /** 题号（0 起，展示 +1；顺序 = blocks 出现顺序，孤儿题排后） */
  index: number;
  question: AttemptQuestionPublic;
  attemptId: string;
  answer: StudentAnswer | undefined;
  /** 作答态的已解锁提示回显 */
  hints: readonly HintOpenedEntry[];
  /** 点过显示答案的当题释放结果（存在即结果态） */
  released: AttemptResultQuestion | undefined;
  /** 作答回调（undefined = 只读：完成视图或防御态） */
  handlers: LessonQuestionHandlers | undefined;
  /**
   * 题卡元素注册（SAI-22 讲练 AI 伴学）：作答态/结果态的卡片元素同步给
   * 页面（伴学材料采集 surfaceOf 与当前题定位）；不传时零行为。
   */
  onCardElement?:
    | ((questionId: string, el: HTMLElement | null) => void)
    | undefined;
  aiTrigger?: ReactNode;
}

/** 讲练页题卡本体 */
export const LessonQuestionCard = memo(function LessonQuestionCard({
  index,
  question,
  attemptId,
  answer,
  hints,
  released,
  handlers,
  onCardElement,
  aiTrigger,
}: LessonQuestionCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phase, setPhase] = useState<RevealPhase>({ kind: "idle" });

  const registerCard = (element: HTMLElement | null) => {
    const card =
      element?.querySelector<HTMLElement>("article[data-question-id]") ??
      element;
    handlers?.registerCard(question.id, card);
    onCardElement?.(question.id, card);
  };

  /** 显示答案（allowMissing=true = 用户已在缺稿弹层明确选择继续） */
  const revealAnswer = async (allowMissing: boolean) => {
    if (handlers === undefined) return;
    setPhase({ kind: "busy" });
    const outcome: LessonSubmitOutcome = await handlers.submit(
      question.id,
      allowMissing ? { allowMissing: true } : undefined,
    );
    if (outcome.kind === "submitted") {
      setDialogOpen(false);
      setPhase({ kind: "idle" });
      return;
    }
    if (outcome.kind === "problems") {
      // 单题语境：problems 只可能是本题（prepareSubmitEvidence 按题调用）
      setPhase({
        kind: "choice",
        reason: outcome.problems[0]?.reason ?? "草稿尚未保存完整",
      });
      setDialogOpen(true);
      return;
    }
    setPhase({ kind: "error", message: outcome.message });
    setDialogOpen(true);
  };

  // ---------- 结果态（点过显示答案，当题释放） ----------
  // 教师演示形态（2026-10）：只留判定徽章（有自动判定才显示）+ 题干与选项
  // 标记 + 参考答案 + 解析直接展示；不做待批刷新/批改块/提示回显/历史与
  // 结果页链接（讲练是老师展示给学生用的轻工具，回看工具在作业结果页）。
  // QM-11：reference_self 行按自评三态显示徽章，对照后挂自评动作（讲练
  // 恒当题释放，教师未判时学生自评即时生效——TT-09a 口径）。
  if (released !== undefined) {
    // 徽章显示参数（单一出处）：reference_self 未评/已评带自评文案；旧行
    // finalCorrect=null 且无自评态 → 不渲染徽章（既有行为）
    const badge = verdictBadgeDisplayOf(released);
    const showBadge =
      badge.verdict !== null || badge.pendingLabel !== undefined;
    return (
      <article
        ref={registerCard}
        data-question-id={question.id}
        tabIndex={-1}
        aria-label={`第 ${index + 1} 题`}
        className={cn(
          "relative flex scroll-mt-24 flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 text-card-foreground shadow-xs sm:p-5 sm:pl-6",
          "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
          badge.verdict === true && "before:bg-emerald-500",
          badge.verdict === false && "before:bg-red-500",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {showBadge && (
            <VerdictBadge
              verdict={badge.verdict}
              toned
              {...(badge.pendingLabel !== undefined && {
                pendingLabel: badge.pendingLabel,
              })}
              {...(badge.correctLabel !== undefined && {
                correctLabel: badge.correctLabel,
              })}
              {...(badge.wrongLabel !== undefined && {
                wrongLabel: badge.wrongLabel,
              })}
            />
          )}
          <h3 className="text-base font-semibold">第 {index + 1} 题</h3>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[released.snapshot.type]}`}
          >
            {QUESTION_TYPE_LABELS[released.snapshot.type]}
          </span>
          <div className="ml-auto">{aiTrigger}</div>
        </div>
        <RichMarkdown
          source={displayStemMd(released.snapshot)}
          className="text-base leading-[1.75]"
        />
        <ResultOptions question={released} released />
        <ResultAnswerComparison question={released} released />
        {/* QM-11：对照后挂自评动作（reference_self 行；教师判定时整块不渲染） */}
        <SelfReviewSection attemptId={attemptId} question={released} />
        {released.solutionMd !== null && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">解析</p>
            <div className="border-s-2 border-border ps-3">
              <RichMarkdown
                source={released.solutionMd}
                className="text-sm leading-6"
              />
            </div>
          </div>
        )}
      </article>
    );
  }

  // ---------- 只读防御态（未提交且无作答回调） ----------
  if (handlers === undefined) {
    return (
      <article
        aria-label={`第 ${index + 1} 题`}
        className="flex flex-col gap-2 rounded-2xl border border-dashed border-border bg-card/60 p-4 text-card-foreground"
      >
        <p className="text-sm font-semibold">第 {index + 1} 题</p>
        <p className="text-sm text-muted-foreground">
          本题暂时不能作答，请刷新页面后重试。
        </p>
      </article>
    );
  }

  // ---------- 作答态 ----------
  const onAnswer: (answer: StudentAnswer, defer?: boolean) => void = (
    next,
    defer,
  ) => handlers.onAnswer(question.id, next, defer ?? false);
  return (
    <div
      ref={registerCard}
      tabIndex={-1}
      className="flex scroll-mt-24 flex-col gap-3 outline-none"
    >
      <AttemptQuestionCard
        index={index}
        question={question}
        attemptId={attemptId}
        answer={answer}
        onAnswer={onAnswer}
        registerInkController={handlers.registerInkController}
        hints={hints}
        onHintUnlocked={(entry) => handlers.onHintUnlocked(question.id, entry)}
        assignmentTitle="讲练"
        aiTrigger={aiTrigger}
        footer={
          <Button
            type="button"
            className="min-h-11 w-fit"
            disabled={phase.kind === "busy"}
            onClick={() => void revealAnswer(false)}
          >
            {phase.kind === "busy" ? "正在显示…" : "显示答案"}
          </Button>
        }
      />

      <LessonRevealDialog
        open={dialogOpen}
        phase={phase}
        onCancel={() => {
          setDialogOpen(false);
          setPhase({ kind: "idle" });
        }}
        onConfirm={(allowMissing) => void revealAnswer(allowMissing)}
      />
    </div>
  );
});
