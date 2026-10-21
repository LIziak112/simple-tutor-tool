import type { AssignmentAnswerRelease } from "@tutor/contract";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDueTime } from "@/lib/time";

/**
 * 交卷确认弹层（T2.6；T6R.10 扩展草稿证据）：
 * - 未答数量警示 + 确认交卷（服务端判分后不可再改）；触控 ≥44px；
 *   提交中禁用按钮防重复交卷（手写题笔迹的强制上传约束在页面层
 *   confirmSubmit 的 ink flush——失败阻止交卷并收起弹层，不在本组件放宽）；
 * - T6R.10 草稿状态区：已同步待固定 / 未保存完整 / 未写计数如实展示
 *   （弹层打开时的本地快览，非权威判定——确认时重新组装）；
 * - T6R.10 明确选择分支（choiceMode）：存在未追平草稿时**不提供**普通
 *   确认——用户只能返回处理，或明确选择「提交答案，草稿未保存完整」
 *   （对应题目证据按 missing 提交，本地稿保留，之后找回只能作为补充材料）；
 *   阻止性错误相（notePrepError）可携带最近一次 problems 清单展示
 *   （错误文案与问题列表都可见——清单来自进入 error 前的 choice 快照）；
 * - preparing/submitting（busy）：正在追平草稿/组装声明/提交——**关闭即
 *   中止**，busy 期间封堵全部关闭路径（Esc/点按遮罩/右上角 ×/按钮），
 *   防准备半途关弹层造成状态与网络链不一致。
 */

/** 弹层打开时的草稿计数快览（本地态；详见 submit-evidence.snapshotNoteOverview） */
export interface SubmitNoteSummary {
  /** 已同步、交卷时固定为原稿的题数 */
  willFreeze: number;
  /** 本地可见未保存完整/冲突/被拒的题数 */
  problem: number;
  /** 未写草稿的题数 */
  unwritten: number;
}

/** 未追平草稿的逐题呈现（明确选择分支/错误相残留清单） */
export interface SubmitNoteProblemView {
  /** 全卷题号（1 起序号，与题卡一致） */
  index: number;
  /** 中文原因（submit-evidence 产出） */
  reason: string;
  domain?: "annotation";
}

/**
 * busy 期间封堵 Radix 关闭路径的三件套（Esc / 点按遮罩 / 外点）：与
 * closeDisabled 同纪律（关闭=取消=中止，busy 中不应发生——准备中途关闭会让
 * 网络链与弹层状态失同步）。整卷交卷确认与讲练单题提交弹层共用（2026-10
 * 讲练一体收口单源）。
 */
export function busyCloseGuard(busy: boolean): {
  onEscapeKeyDown: (event: { preventDefault: () => void }) => void;
  onPointerDownOutside: (event: { preventDefault: () => void }) => void;
  onInteractOutside: (event: { preventDefault: () => void }) => void;
} {
  const block = (event: { preventDefault: () => void }): void => {
    if (busy) event.preventDefault();
  };
  return {
    onEscapeKeyDown: block,
    onPointerDownOutside: block,
    onInteractOutside: block,
  };
}

/**
 * 缺稿警示块（destructive 描边容器）：整卷交卷确认与讲练单题提交弹层共用；
 * 标题/正文/尾注由调用方给定（单题与整卷的文案口径不同，见各弹层）。
 */
export function DraftProblemAlert({
  title,
  children,
  footnote,
}: {
  title: string;
  children: ReactNode;
  footnote: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm leading-6"
    >
      <p className="font-medium text-destructive">{title}</p>
      {children}
      <p className="mt-1.5 text-muted-foreground">{footnote}</p>
    </div>
  );
}

export function SubmitConfirmDialog({
  open,
  unansweredCount,
  submitting,
  preparing = false,
  noteSummary = null,
  noteProblems = null,
  choiceMode = false,
  notePrepError = null,
  onConfirm,
  onConfirmMissing,
  onCancel,
  incompleteQuestions = [],
  onGoToQuestion,
  dueAt = null,
  answerRelease = "on_submit",
}: {
  open: boolean;
  /** 未作答题数（0 时也确认一次，防止误触） */
  unansweredCount: number;
  submitting: boolean;
  /** 正在追平草稿/组装证据声明（按钮禁用 + 同步文案） */
  preparing?: boolean;
  /** 草稿计数快览（null=不展示该区——如会话未绑定） */
  noteSummary?: SubmitNoteSummary | null;
  /** 未追平草稿清单（choice 相或 error 相携带的最近一次清单；**非 null 时必非空**——只在 problems 非空时产生） */
  noteProblems?: SubmitNoteProblemView[] | null;
  /** 明确选择分支（确认键退化为「提交答案，草稿未保存完整」） */
  choiceMode?: boolean;
  /** 追平/组装的阻止性错误（head 拉取失败等；重试点确认即重试） */
  notePrepError?: string | null;
  onConfirm: () => void;
  /** 缺稿交卷的明确确认（用户选择「提交答案，草稿未保存完整」） */
  onConfirmMissing?: () => void;
  onCancel: () => void;
  incompleteQuestions?: readonly { id: string; index: number; label: string }[];
  onGoToQuestion?: (id: string) => void;
  /** 截止时间（UTC ISO），用于截止后公布时展示预期 */
  dueAt?: string | null;
  /** 公布时机（草稿视图契约字段；与 dueAt 组合判定「截止后公布」预期文案） */
  answerRelease?: AssignmentAnswerRelease;
}) {
  const busy = submitting || preparing;
  const annotationProblem =
    noteProblems?.some((problem) => problem.domain === "annotation") ?? false;
  // 「截止后公布」前置预期 = 策略为 after_due 且此刻未到截止（到点后交卷即
  // 完整公布，与 on_submit 同文案）。dueAt 缺失/已过/不可解析都不展示该预期。
  const afterDueDueAt =
    answerRelease === "after_due" &&
    dueAt !== null &&
    dueAt !== undefined &&
    !Number.isNaN(Date.parse(dueAt)) &&
    Date.parse(dueAt) > Date.now()
      ? dueAt
      : null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        className="flex max-h-[min(88dvh,720px)] w-[calc(100%-24px)] flex-col overflow-hidden"
        aria-describedby="submit-confirm-desc"
        closeDisabled={busy}
        // busy 期间封堵 Radix 关闭路径（关闭=取消=中止——中止只应发生在
        // 可恢复的边界；准备中关闭会让网络链与弹层状态失同步）
        {...busyCloseGuard(busy)}
      >
        <DialogHeader>
          <DialogTitle>确认交卷吗？</DialogTitle>
          <DialogDescription
            id="submit-confirm-desc"
            className="text-sm leading-6"
          >
            {afterDueDueAt !== null
              ? unansweredCount > 0
                ? `还有 ${unansweredCount} 题没有作答。老师设置了截止后公布，交卷后答案将妥善保存，成绩与详解将在截止后（${formatDueTime(afterDueDueAt)}）统一公布。确认交卷吗？`
                : `全部题目已作答。老师设置了截止后公布，交卷后答案将妥善保存，成绩与详解将在截止后（${formatDueTime(afterDueDueAt)}）统一公布。确认交卷吗？`
              : unansweredCount > 0
                ? `还有 ${unansweredCount} 题没有作答，交卷后不能再修改答案。`
                : "全部题目已作答，交卷后立即判分且不能再修改答案。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-1 -m-1">
          {incompleteQuestions.length > 0 && onGoToQuestion && (
            <fieldset
              className="m-0 flex flex-wrap gap-2 border-0 p-0"
              aria-label="待补全题目"
            >
              {incompleteQuestions.map((question) => (
                <Button
                  key={question.id}
                  type="button"
                  variant="outline"
                  className="min-h-11 max-w-full whitespace-normal"
                  disabled={busy}
                  aria-label={`去补全第 ${question.index + 1} 题，${question.label}`}
                  onClick={() => onGoToQuestion(question.id)}
                >
                  第 {question.index + 1} 题 · {question.label}
                </Button>
              ))}
            </fieldset>
          )}

          {/* T6R.10 草稿状态区（本地快览；确认时以重新组装的权威判定为准） */}
          {noteSummary !== null && !choiceMode && noteProblems === null && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-6 text-muted-foreground">
              草稿：
              {noteSummary.willFreeze > 0 && (
                <>{noteSummary.willFreeze} 题草稿已同步，交卷时固定为原稿</>
              )}
              {noteSummary.willFreeze > 0 && noteSummary.problem > 0 && "；"}
              {noteSummary.problem > 0 && (
                <span className="text-destructive">
                  {noteSummary.problem} 题草稿未保存完整
                </span>
              )}
              {(noteSummary.willFreeze > 0 || noteSummary.problem > 0) &&
                noteSummary.unwritten > 0 &&
                "；"}
              {noteSummary.unwritten > 0 &&
                `其余 ${noteSummary.unwritten} 题未写草稿`}
              。
            </p>
          )}

          {/* T6R.10 未追平草稿清单：choice 相（缺稿交卷必须明确选择）或
            error 相（携带最近一次清单——错误文案与问题列表都可见）。
            noteProblems 非 null 时必非空——只在 problems 非空时产生
            （不变量，见 NotePrepPhase 注释） */}
          {noteProblems !== null && (
            <DraftProblemAlert
              title={`以下题目的${annotationProblem ? "材料" : "草稿"}未保存完整：`}
              footnote={
                annotationProblem
                  ? "可以返回重试同步，或仅交答案。本机标画不会删除，但未上传的标画不能视为交卷原稿；未保存草稿按缺稿提交。"
                  : "可以返回重试同步；或明确选择提交——这些题目的草稿将标记为「未保存」，交卷后找回的内容只能作为补充材料，不会算作原稿。"
              }
            >
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {noteProblems.map((problem) => (
                  <li key={`${problem.index}:${problem.domain ?? "scratch"}`}>
                    第 {problem.index} 题：{problem.reason}
                  </li>
                ))}
              </ul>
            </DraftProblemAlert>
          )}

          {preparing && (
            <p className="text-xs text-muted-foreground">
              正在同步草稿并确认可固定的版本，请稍候…
            </p>
          )}

          {/* 阻止性错误（head 拉取失败等）：如实提示，重试点确认即重试 */}
          {notePrepError !== null && (
            <p role="alert" className="text-xs text-destructive">
              {notePrepError}
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
          {choiceMode ? (
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={onConfirmMissing}
              disabled={busy}
            >
              {busy
                ? "正在交卷…"
                : annotationProblem
                  ? "仅交答案，未保存材料留在本机"
                  : "提交答案，草稿未保存完整"}
            </Button>
          ) : (
            <Button className="min-h-11" onClick={onConfirm} disabled={busy}>
              {busy ? "正在交卷…" : "确认交卷"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
