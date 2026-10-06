import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 交卷确认弹层（T2.6；T6R.10 扩展草稿证据）：
 * - 未答数量警示 + 确认交卷（服务端判分后不可再改）；触控 ≥44px；
 *   提交中禁用按钮防重复交卷（手写题笔迹的强制上传约束在页面层
 *   confirmSubmit 的 ink flush——失败阻止交卷并收起弹层，不在本组件放宽）；
 * - T6R.10 草稿状态区：已同步待固定 / 未保存完整 / 未写计数如实展示
 *   （弹层打开时的本地快览，非权威判定——确认时重新组装）；
 * - T6R.10 明确选择分支（noteProblems 非 null）：存在未追平草稿时**不提供**
 *   普通确认——用户只能返回处理，或明确选择「提交答案，草稿未保存完整」
 *   （对应题目证据按 missing 提交，本地稿保留，之后找回只能作为补充材料）；
 * - preparing：正在追平草稿/组装证据声明（等待本地事务与上传回执），
 *   按钮禁用防半途交卷。
 */

/** 弹层打开时的草稿计数快览（本地态；详见 submit-evidence.snapshotNoteOverview） */
export interface SubmitNoteSummary {
  /** 已同步、交卷时将固定为原稿的题数 */
  willFreeze: number;
  /** 本地可见未保存完整/冲突/被拒的题数 */
  problem: number;
  /** 未写草稿的题数 */
  unwritten: number;
}

/** 未追平草稿的逐题呈现（进入明确选择分支时） */
export interface SubmitNoteProblemView {
  /** 全卷题号（1 起序号，与题卡一致） */
  index: number;
  /** 中文原因（submit-evidence 产出） */
  reason: string;
}

export function SubmitConfirmDialog({
  open,
  unansweredCount,
  submitting,
  preparing = false,
  noteSummary = null,
  noteProblems = null,
  notePrepError = null,
  onConfirm,
  onConfirmMissing,
  onCancel,
}: {
  open: boolean;
  /** 未作答题数（0 时也确认一次，防止误触） */
  unansweredCount: number;
  submitting: boolean;
  /** 正在追平草稿/组装证据声明（按钮禁用 + 同步文案） */
  preparing?: boolean;
  /** 草稿计数快览（null=不展示该区——如会话未绑定） */
  noteSummary?: SubmitNoteSummary | null;
  /** 未追平草稿清单（非 null 进入明确选择分支；**非 null 时必非空**——调用方只在 problems 非空时置该分支） */
  noteProblems?: SubmitNoteProblemView[] | null;
  /** 追平/组装的阻止性错误（head 拉取失败等；重试点确认即重试） */
  notePrepError?: string | null;
  onConfirm: () => void;
  /** 缺稿交卷的明确确认（用户选择「提交答案，草稿未保存完整」） */
  onConfirmMissing?: () => void;
  onCancel: () => void;
}) {
  const busy = submitting || preparing;
  const choiceMode = noteProblems !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent aria-describedby="submit-confirm-desc">
        <DialogHeader>
          <DialogTitle>确认交卷吗？</DialogTitle>
          <DialogDescription
            id="submit-confirm-desc"
            className="text-sm leading-6"
          >
            {unansweredCount > 0
              ? `还有 ${unansweredCount} 题没有作答，交卷后不能再修改答案。`
              : "全部题目已作答，交卷后立即判分且不能再修改答案。"}
          </DialogDescription>
        </DialogHeader>

        {/* T6R.10 草稿状态区（本地快览；确认时以重新组装的权威判定为准） */}
        {noteSummary !== null && !choiceMode && (
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

        {/* T6R.10 明确选择分支：未追平草稿如实呈现，缺稿交卷必须明确选择。
            noteProblems 非 null 时必非空——调用方（AttemptSession）只在
            problems.length>0 时置 choice（不变量，见 NotePrepPhase 注释） */}
        {choiceMode && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm leading-6"
          >
            <p className="font-medium text-destructive">
              以下题目的草稿未保存完整：
            </p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {noteProblems.map((problem) => (
                <li key={problem.index}>
                  第 {problem.index} 题：{problem.reason}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">
              可以返回重试同步；或明确选择提交——这些题目的草稿将标记为
              「未保存」，交卷后找回的内容只能作为补充材料，不会算作原稿。
            </p>
          </div>
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

        <DialogFooter>
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
              {busy ? "正在交卷…" : "提交答案，草稿未保存完整"}
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
