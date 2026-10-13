import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  StudentAnswer,
} from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import { LoaderCircle } from "lucide-react";
import { memo, useState } from "react";
import { Link } from "react-router";
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
  SolutionFold,
  TeacherMarkBlock,
  VerdictBadge,
} from "@/features/attempt/AttemptResultView";
import {
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { HintEntryList } from "@/features/attempt/HintPanel";
import { getQuestionCompletion } from "@/features/attempt/question-completion";
import { ResultAnswerComparison } from "@/features/attempt/ResultAnswerComparison";
import {
  busyCloseGuard,
  DraftProblemAlert,
} from "@/features/attempt/SubmitConfirmDialog";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { QuestionHistoryLink } from "@/features/notes/QuestionHistoryLink";
import type {
  LessonQuestionHandlers,
  LessonSubmitOutcome,
} from "./use-lesson-attempt";

/**
 * 讲练页题卡（2026-10 讲练一体）：讲义段落间的可作答题卡。
 * - 作答态（未提交）：题干投影（QuestionSurface）+ 按题型作答（客观题控件在
 *   QuestionSurface 内、手写题 HandwrittenControls 内含最终答案输入）+
 *   分步提示（HintPanel）+「提交本题」（提交前确认弹层；触控 ≥44px）；
 * - 结果态（已单题提交，当题释放）：对错徽章（finalCorrect 优先，null=
 *   「待老师批改」+ 手动刷新）+ 题干快照与选项标记 + 参考答案（ResultAnswerComparison）
 *   + 老师批改块 + 已解锁提示回显 + 详解折叠（SolutionFold，遵循
 *   enabledCapabilities 的 steps 开关——Provider 由页面提供）+ 本题历史链接；
 *   attempt 收尾后附「查看完整结果页」链接（订正/笔记等回看工具在结果页）；
 * - 只读防御态：既未提交又无作答回调（异常数据形态）——提示刷新。
 * 作答链路全部经 handlers 复用答题页既有 hook（use-lesson-attempt 单一出处）。
 */

/** 单题提交确认弹层的阶段（一次 set 完成迁移，无中间组合态） */
type SubmitPhase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "choice"; reason: string }
  | { kind: "error"; message: string };

/**
 * 单题提交确认弹层：提交前确认（未作答警示）+ 草稿未保存完整的明确选择
 * （复用整卷 T6R.10 的语义：缺稿提交须用户明确选择）+ 阻止性错误展示。
 * busy 期间封堵关闭路径（与 SubmitConfirmDialog 同纪律）。
 */
function LessonSubmitDialog({
  open,
  answered,
  phase,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  answered: boolean;
  phase: SubmitPhase;
  onCancel: () => void;
  onConfirm: (allowMissing: boolean) => void;
}) {
  const busy = phase.kind === "busy";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent
        className="flex max-h-[min(80dvh,640px)] w-[calc(100%-24px)] flex-col"
        aria-describedby="lesson-submit-desc"
        closeDisabled={busy}
        // busy 封堵与警示块与整卷 SubmitConfirmDialog 同源（单一出处）
        {...busyCloseGuard(busy)}
      >
        <DialogHeader>
          <DialogTitle>提交本题吗？</DialogTitle>
          <DialogDescription
            id="lesson-submit-desc"
            className="text-sm leading-6"
          >
            {answered
              ? "提交后本题答案不能再修改，将立即显示对错与解析。"
              : "这道题还没有作答，提交后将按未答处理，且不能再修改。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-1 -m-1">
          {phase.kind === "choice" && (
            <DraftProblemAlert
              title="这道题的草稿未保存完整："
              footnote="可以返回稍等同步完成；或明确选择提交——草稿将标记为「未保存」， 之后找回的内容只能作为补充材料。"
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
              正在同步草稿并提交，请稍候…
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
            继续作答
          </Button>
          {phase.kind === "choice" ? (
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => onConfirm(true)}
              disabled={busy}
            >
              {busy ? "正在提交…" : "提交答案，草稿未保存完整"}
            </Button>
          ) : (
            <Button
              className="min-h-11"
              onClick={() => onConfirm(false)}
              disabled={busy}
            >
              {busy ? "正在提交…" : "确认提交"}
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
  /** 已单题提交的当题释放结果（存在即结果态） */
  released: AttemptResultQuestion | undefined;
  /** attempt 已收尾（结果卡附「查看完整结果页」链接） */
  attemptCompleted: boolean;
  /** 作答回调（undefined = 只读：完成视图或防御态） */
  handlers: LessonQuestionHandlers | undefined;
  /** 待批题手动刷新（重新拉 start 取教师批改结果） */
  onRefresh: () => void;
}

/** 讲练页题卡本体 */
export const LessonQuestionCard = memo(function LessonQuestionCard({
  index,
  question,
  attemptId,
  answer,
  hints,
  released,
  attemptCompleted,
  handlers,
  onRefresh,
}: LessonQuestionCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phase, setPhase] = useState<SubmitPhase>({ kind: "idle" });

  const registerCard = (element: HTMLElement | null) => {
    const card =
      element?.querySelector<HTMLElement>("article[data-question-id]") ??
      element;
    handlers?.registerCard(question.id, card);
  };

  /** 确认提交（allowMissing=true = 用户已明确选择缺稿提交） */
  const confirmSubmit = async (allowMissing: boolean) => {
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
      return;
    }
    setPhase({ kind: "error", message: outcome.message });
  };

  // ---------- 结果态（已单题提交，当题释放） ----------
  if (released !== undefined) {
    const pending = released.finalCorrect === null;
    return (
      <article
        ref={registerCard}
        data-question-id={question.id}
        tabIndex={-1}
        aria-label={`第 ${index + 1} 题`}
        className={cn(
          "relative flex scroll-mt-24 flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 text-card-foreground shadow-xs sm:p-5 sm:pl-6",
          "before:absolute before:inset-y-0 before:left-0 before:w-1.5",
          released.finalCorrect === true && "before:bg-emerald-500",
          released.finalCorrect === false && "before:bg-red-500",
          pending && "before:bg-amber-400",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* 判定徽章单一出处（AttemptResultView）：讲练页覆盖待批文案 */}
          <VerdictBadge
            verdict={released.finalCorrect}
            pendingLabel="待老师批改"
            toned
          />
          <h3 className="text-base font-semibold">第 {index + 1} 题</h3>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[released.snapshot.type]}`}
          >
            {QUESTION_TYPE_LABELS[released.snapshot.type]}
          </span>
          {/* 课中批改即时下发靠学生手动刷新承载（方案决策 4） */}
          {pending && (
            <Button
              type="button"
              variant="outline"
              className="ml-auto min-h-11"
              onClick={onRefresh}
            >
              <LoaderCircle aria-hidden className="size-4" />
              刷新
            </Button>
          )}
        </div>
        <RichMarkdown
          source={displayStemMd(released.snapshot)}
          className="text-base leading-[1.75]"
        />
        <ResultOptions question={released} released />
        <ResultAnswerComparison question={released} released />
        {(released.teacherMark !== null ||
          released.teacherComment !== null) && (
          <TeacherMarkBlock
            teacherMark={released.teacherMark}
            teacherComment={released.teacherComment}
          />
        )}
        {released.hintsOpened.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              做题时看过的提示（{released.hintsOpened.length} 条）
            </p>
            <HintEntryList entries={released.hintsOpened} />
          </div>
        )}
        <SolutionFold solutionMd={released.solutionMd} />
        <div className="flex flex-wrap items-center gap-2">
          <QuestionHistoryLink
            questionId={question.id}
            ariaPrefix={`第 ${index + 1} 题`}
          />
          {attemptCompleted && (
            <Link
              to={`/s/attempts/${attemptId}`}
              className="flex min-h-11 items-center gap-1 whitespace-nowrap rounded-lg border border-border px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              查看完整结果页
            </Link>
          )}
        </div>
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
        footer={
          <Button
            type="button"
            className="min-h-11 w-fit"
            onClick={() => {
              setPhase({ kind: "idle" });
              setDialogOpen(true);
            }}
          >
            提交本题
          </Button>
        }
      />

      <LessonSubmitDialog
        open={dialogOpen}
        answered={
          getQuestionCompletion(question, answer, false).state === "filled"
        }
        phase={phase}
        onCancel={() => {
          setDialogOpen(false);
          setPhase({ kind: "idle" });
        }}
        onConfirm={(allowMissing) => void confirmSubmit(allowMissing)}
      />
    </div>
  );
});
