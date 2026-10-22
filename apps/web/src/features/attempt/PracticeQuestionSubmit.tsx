import type {
  PracticeQuestionFeedback,
  PracticeWorkflow,
} from "@tutor/contract";
import { ArrowRight, Eye, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { practiceUnreadableFeedbackCopy } from "./practice-protocol";
import { QuestionFeedback } from "./QuestionFeedback";
import { busyCloseGuard, DraftProblemAlert } from "./SubmitConfirmDialog";

/**
 * 逐题提交交互呈现件（M3-D2，§7.2/§8/§9.1/§11-2）：
 * - PracticeQuestionFooter：题卡 footer 槽的本题提交区（列表模式含提交按钮，
 *   单题模式只呈现反馈——提交按钮在 SingleQuestionActionBar 主操作位）；
 *   已提交行原位追加反馈区（题面宿主与题干位置不变，输入只读由 readOnly
 *   链路承担，呈现层防线，服务端行级锁定才是边界）；
 * - PracticeSingleActions：单题主操作位三态——提交本题（含「不会」空答案
 *   提交）→ 正在提交… → 下一题 / 查看本次结果（+ 继续未提交题目）。
 * 状态纪律：已提交以 questionProgress/回执为准；错误就地提示可重试，不弹
 * 确认层（缺稿明确选择弹层由页面层 PracticeSubmitProblemDialog 承担）。
 */

/** 就地错误/重试提示行（提交失败与反馈读取失败共用口径） */
function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** 已提交可读但反馈尚未取回：轻量等待或重试入口（失败可重试） */
function FeedbackPending({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
        <Eye aria-hidden className="size-4" />
        <span>本题反馈暂时没有读取到</span>
        <Button
          variant="outline"
          className="min-h-9 px-3 text-xs"
          onClick={onRetry}
        >
          重新读取
        </Button>
      </div>
    );
  }
  return (
    <p
      data-slot="practice-feedback-pending"
      className="flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground"
    >
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      正在读取本题反馈…
    </p>
  );
}

/** 题卡 footer 槽：v1 卷的本题提交区 / 已提交反馈区（legacy 不挂） */
export function PracticeQuestionFooter({
  mode,
  submitted,
  readable,
  answered,
  busy,
  anyBusy,
  feedback,
  feedbackFailed,
  workflow,
  error,
  onSubmit,
  onRetryFeedback,
}: {
  /** list = 列表模式（footer 承担提交按钮）；single = 单题模式（按钮在主操作位） */
  mode: "list" | "single";
  submitted: boolean;
  readable: boolean;
  answered: boolean;
  busy: boolean;
  anyBusy: boolean;
  feedback: PracticeQuestionFeedback | null;
  feedbackFailed: boolean;
  /** 本地不可读文案依据（教师受限按原因，否则统一公布）；undefined 按统一公布 */
  workflow: PracticeWorkflow | undefined;
  error: string | null;
  onSubmit: (opts?: { allowMissing?: boolean }) => void;
  onRetryFeedback: () => void;
}) {
  if (!submitted) {
    if (mode === "single") return null;
    return (
      <div
        data-slot="practice-question-submit"
        className="flex min-w-0 flex-col gap-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            className="min-h-11 w-fit px-4"
            disabled={!answered || busy || anyBusy}
            onClick={() => onSubmit()}
          >
            {busy ? "正在提交…" : "提交本题"}
          </Button>
          {!answered && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit px-4"
              disabled={busy || anyBusy}
              onClick={() => onSubmit()}
            >
              不会，提交并看解析
            </Button>
          )}
        </div>
        {error !== null && <InlineError message={error} />}
      </div>
    );
  }
  // 已提交：反馈区原位追加（两种模式同位）；可读但未取回按等待/重试呈现
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {feedback !== null ? (
        <QuestionFeedback feedback={feedback} />
      ) : readable ? (
        <FeedbackPending failed={feedbackFailed} onRetry={onRetryFeedback} />
      ) : (
        <p
          data-slot="practice-question-feedback"
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          {workflow === undefined
            ? "已提交，交卷后统一公布"
            : practiceUnreadableFeedbackCopy(workflow)}
        </p>
      )}
      {mode === "list" && error !== null && <InlineError message={error} />}
    </div>
  );
}

/** 单题主操作位三态（SingleQuestionActionBar 的 middle 内容） */
export function PracticeSingleActions({
  submitted,
  answered,
  busy,
  finished,
  hasNext,
  continueUnsubmittedId,
  error,
  onSubmit,
  onNext,
  onViewResult,
  onContinue,
}: {
  submitted: boolean;
  answered: boolean;
  busy: boolean;
  /** 回执收尾（attempt 离开 draft）：主动作查看本次结果，不自动跳转 */
  finished: boolean;
  hasNext: boolean;
  /** 仍有未提交题时给「继续未提交题目」（null = 无或即当前题） */
  continueUnsubmittedId: string | null;
  error: string | null;
  onSubmit: () => void;
  onNext: () => void;
  onViewResult: () => void;
  onContinue: (id: string) => void;
}) {
  if (!submitted) {
    return (
      <div
        data-slot="practice-primary-action"
        className="flex min-w-0 flex-col gap-1.5"
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            className="min-h-11 w-fit px-5"
            disabled={!answered || busy}
            onClick={onSubmit}
          >
            {busy ? (
              <>
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                正在提交…
              </>
            ) : (
              "提交本题"
            )}
          </Button>
          {!answered && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit px-4"
              disabled={busy}
              onClick={onSubmit}
            >
              不会，提交并看解析
            </Button>
          )}
        </div>
        {error !== null && (
          <div className="flex justify-end">
            <InlineError message={error} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      data-slot="practice-primary-action"
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
    >
      {finished ? (
        <Button
          type="button"
          className="min-h-11 w-fit px-5"
          onClick={onViewResult}
        >
          查看本次结果
        </Button>
      ) : hasNext ? (
        <Button type="button" className="min-h-11 w-fit px-5" onClick={onNext}>
          下一题
          <ArrowRight aria-hidden className="size-4" />
        </Button>
      ) : null}
      {continueUnsubmittedId !== null && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-fit px-4"
          onClick={() => onContinue(continueUnsubmittedId)}
        >
          继续未提交题目
        </Button>
      )}
    </div>
  );
}

/** 缺稿明确选择弹层阶段（一次 set 完成迁移；lesson 显示答案兜底弹层同族） */
export type PracticeProblemPhase =
  | { kind: "choice"; reason: string }
  | { kind: "busy" }
  | { kind: "error"; message: string };

/**
 * 逐题提交的缺稿明确选择弹层（M3-D2，§10.3）：证据组装发现本题草稿未保存
 * 完整时**不静默放行**——用户只能返回作答，或明确选择「提交本题，草稿未
 * 保存完整」（该题证据按缺稿提交，本机稿保留）。busy（确认后的重提进行中）
 * 封堵全部关闭路径，与整卷 SubmitConfirmDialog / lesson 兜底弹层同源纪律。
 */
export function PracticeSubmitProblemDialog({
  open,
  phase,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  phase: PracticeProblemPhase;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const busy = phase.kind === "busy";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent
        className="flex max-h-[min(80dvh,640px)] w-[calc(100%-24px)] flex-col"
        aria-describedby="practice-problem-desc"
        closeDisabled={busy}
        // busy 封堵与整卷 SubmitConfirmDialog 同源（单一出处）
        {...busyCloseGuard(busy)}
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === "error" ? "提交失败" : "草稿未保存完整"}
          </DialogTitle>
          <DialogDescription
            id="practice-problem-desc"
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
              footnote="可以返回稍等同步完成；或明确选择继续——草稿将标记为「未保存」，之后找回的内容只能作为补充材料。"
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
              正在同步草稿并提交本题，请稍候…
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
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "正在提交…" : "提交本题，草稿未保存完整"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
