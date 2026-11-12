import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ATTEMPT_REVIEW_STATUS_LABEL,
  type AttemptReviewEntryState,
  attemptReviewEntryViewOf,
  useAttemptReviewEntry,
} from "./attempt-review-entry";

/**
 * 结果页「可复盘」提示条（2026-11-09 个人学习迭代模块 1「交卷后给一个入口」）：
 * 交卷并公布后自动出现在汇总卡下方，用一句话说明整卷复盘现在到哪了。
 * 与顶栏入口共用同一份状态（useAttemptReviewEntry）和同一个打开目标——
 * 提示条负责解释，顶栏负责随时可达；两处不会各说各话。
 * - 可用门全部在服务端：预览被拒绝即不渲染，不在前端猜；
 * - 只提示不代发、不记已读：点按钮只是打开发起 / 进度面板或报告阅读器。
 */

/** 提示条文案与按钮（按钮文字写清楚点了会发生什么，不用单独一个「查看」） */
function hintTextOf(
  state: AttemptReviewEntryState,
): { text: string; action: string; emphasis: boolean } | null {
  switch (state.kind) {
    case "unavailable":
      return null; // 未公布 / 加载中 / 服务端不允许：不提示，不猜
    case "launch":
      return {
        text: `本卷可以做整卷复盘：共 ${state.counts.total} 题、已判 ${state.counts.gradedCount} 题，AI 按整卷给一份复盘报告`,
        action: "预览并确认",
        emphasis: true,
      };
    case "waiting":
    case "processing":
      return {
        text: `整卷复盘进行中：${ATTEMPT_REVIEW_STATUS_LABEL[state.task.status]}（覆盖 ${state.task.questionCount} 题）`,
        action: "查看进度",
        emphasis: false,
      };
    case "report":
      return {
        text: state.unread
          ? "整卷复盘报告已生成，还没看过"
          : "整卷复盘报告已看过，可以随时再打开",
        action: "打开报告",
        emphasis: state.unread,
      };
    case "attention":
      return {
        text: `上次整卷复盘${ATTEMPT_REVIEW_STATUS_LABEL[state.task.status]}，需要你处理`,
        action: "查看并处理",
        emphasis: false,
      };
  }
}

export function AiAttemptReviewHint({
  attemptId,
  released,
  onOpen,
}: {
  readonly attemptId: string;
  readonly released: boolean;
  /** 打开整卷复盘：target = "panel" 或某份报告的任务 id（与顶栏入口同一目标） */
  readonly onOpen: (target: string) => void;
}) {
  const state = useAttemptReviewEntry(attemptId, released);
  const hint = hintTextOf(state);
  const view = attemptReviewEntryViewOf(state);
  if (hint === null || view === null) return null;
  return (
    <div
      role="status"
      data-testid="attempt-review-hint"
      className={
        hint.emphasis
          ? "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm"
          : "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground"
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText aria-hidden className="size-4 shrink-0" />
        {hint.text}
      </span>
      <Button
        type="button"
        variant={hint.emphasis ? "default" : "outline"}
        className="min-h-11 px-4"
        onClick={() => onOpen(view.target)}
      >
        {hint.action}
      </Button>
    </div>
  );
}
