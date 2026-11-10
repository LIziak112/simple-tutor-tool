import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiAttemptReviewTaskPublic } from "@tutor/contract";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
} from "@/lib/api";
import {
  AiAttemptReviewPanel,
  ATTEMPT_REVIEW_STATUS_LABEL,
} from "./AiAttemptReviewPanel";

/**
 * 结果页「可复盘」提示条（2026-11-09 个人学习迭代模块 1「交卷后给一个入口」）：
 * 交卷并公布后自动出现，告诉本人现在能不能发一次整体复盘、上次发的到哪了。
 * - 可用门全部在服务端：预览接口（整卷已交 + 答案已公布 + 全部题当前策略允许）
 *   拒绝即不渲染「可复盘」，不在前端猜；
 * - 只提示不代发：点「预览并确认」打开既有整体复盘面板，本人确认后才创建任务
 *   （创建 / 领取 / 读材料 / 回信交付仍逐步重验权限）；
 * - 有任务时改报进度：等待领取 / 处理中 / 已出报告（未读高亮）/ 已暂停或失败
 *   （面板里可重试 —— 策略变化导致暂停后由本人选择是否继续）。
 */
export const attemptReviewListKey = (attemptId: string) =>
  ["student-ai", "attempt-reviews", attemptId] as const;
export const attemptReviewPreviewKey = (attemptId: string) =>
  ["student-ai", "attempt-review-preview", attemptId] as const;

/** 活动中的任务优先，其次最近一次有结局的任务；全部已取消 / 归档则无 */
export function pickAttemptReviewTask(
  tasks: readonly AiAttemptReviewTaskPublic[],
): AiAttemptReviewTaskPublic | undefined {
  const live = tasks.filter(
    (task) => task.archivedAt === null && task.status !== "cancelled",
  );
  const rank = (task: AiAttemptReviewTaskPublic): number =>
    task.status === "claimed" || task.status === "created"
      ? 0
      : task.status === "replied"
        ? 1
        : 2;
  return [...live].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  )[0];
}

export function AiAttemptReviewHint({
  attemptId,
  released,
}: {
  readonly attemptId: string;
  readonly released: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const tasksQuery = useQuery({
    queryKey: attemptReviewListKey(attemptId),
    queryFn: () => listStudentAiAttemptReviewsApi(attemptId),
    enabled: released,
    staleTime: 15_000,
    retry: false,
  });
  const task =
    tasksQuery.data === undefined
      ? undefined
      : pickAttemptReviewTask(tasksQuery.data.tasks);
  const previewQuery = useQuery({
    queryKey: attemptReviewPreviewKey(attemptId),
    queryFn: () => fetchStudentAiAttemptReviewPreviewApi(attemptId),
    enabled: released && tasksQuery.isSuccess && task === undefined,
    staleTime: 15_000,
    retry: false,
  });
  if (!released) return null;

  let text: string | null = null;
  let action = "查看";
  let emphasis = false;
  if (task !== undefined) {
    if (task.status === "replied") {
      emphasis = task.openedAt === null;
      text = emphasis
        ? "整体复盘报告已到，还没看过"
        : "整体复盘已完成，可再看一次报告";
    } else if (task.status === "created" || task.status === "claimed") {
      text = `整体复盘进行中：${ATTEMPT_REVIEW_STATUS_LABEL[task.status]}（覆盖 ${task.questionCount} 题）`;
      action = "查看进度";
    } else {
      text = `上次整体复盘${ATTEMPT_REVIEW_STATUS_LABEL[task.status]}`;
      action = "查看并处理";
    }
  } else if (previewQuery.data !== undefined) {
    const counts = previewQuery.data.counts;
    text = `本卷可复盘：共 ${counts.total} 题、已判 ${counts.gradedCount} 题，Agent 可按整卷给一次复盘建议`;
    action = "预览并确认";
    emphasis = true;
  }
  if (text === null) return null; // 未公布 / 加载中 / 服务端不允许：不提示，不猜

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // 面板里可能创建 / 重试 / 取消了任务：关上就按最新状态重新提示
      void queryClient.invalidateQueries({
        queryKey: attemptReviewListKey(attemptId),
      });
      void queryClient.invalidateQueries({
        queryKey: attemptReviewPreviewKey(attemptId),
      });
    }
  };
  return (
    <div
      role="status"
      data-testid="attempt-review-hint"
      className={
        emphasis
          ? "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm"
          : "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground"
      }
    >
      <span className="flex items-center gap-2">
        <ListChecks aria-hidden className="size-4 shrink-0" />
        {text}
      </span>
      <Button
        type="button"
        variant={emphasis ? "default" : "outline"}
        size="sm"
        className="min-h-9"
        onClick={() => setOpen(true)}
      >
        {action}
      </Button>
      {open && (
        <AiAttemptReviewPanel
          attemptId={attemptId}
          released={released}
          open
          onOpenChange={onOpenChange}
        />
      )}
    </div>
  );
}
