import type {
  AiAttemptOriginSummary,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { attemptOriginLineOf, QueueTypeTag, shortTimeOf } from "./AiQueueItem";
import {
  ATTEMPT_REVIEW_PANEL_TARGET,
  ATTEMPT_REVIEW_STATUS_LABEL,
} from "./attempt-review-entry";
import {
  type useAttemptReviewQueue,
  useAttemptReviewQueueAction,
} from "./attempt-review-queue";
import { errorMessageOf } from "./error-text";

/**
 * 「求助记录」的整卷复盘段：每条整卷任务一张卡（类型、状态、发起时间、
 * 卷名 · 来源 · 第几次 · 覆盖题数）。主按钮只负责去那次作答的结果页打开
 * 报告或进度面板（onOpen）——这里不取报告正文、不记已读。
 */

const ACTION_LABEL = {
  cancel: "取消",
  retry: "重试",
  archive: "归档",
} as const;

/** 主按钮：文字写清楚点了会打开什么；已取消的任务没有可看的内容 */
function primaryOf(
  task: AiAttemptReviewTaskPublic,
): { label: string; target: string } | null {
  switch (task.status) {
    case "replied":
      return { label: "查看整卷复盘报告", target: task.id };
    case "created":
    case "claimed":
      return { label: "查看进度", target: ATTEMPT_REVIEW_PANEL_TARGET };
    case "paused":
    case "failed":
      return { label: "查看并处理", target: ATTEMPT_REVIEW_PANEL_TARGET };
    case "cancelled":
      return null;
  }
}

function ReviewCard({
  task,
  origin,
  onOpen,
}: {
  task: AiAttemptReviewTaskPublic;
  origin: AiAttemptOriginSummary | undefined;
  onOpen: (task: AiAttemptReviewTaskPublic, target: string) => void;
}) {
  const actionMutation = useAttemptReviewQueueAction();
  const unread = task.status === "replied" && task.openedAt === null;
  const primary = primaryOf(task);
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <QueueTypeTag icon={FileText}>整卷复盘</QueueTypeTag>
        <span
          className={`rounded px-1.5 py-0.5 font-medium ${
            unread
              ? "bg-primary/15 text-primary"
              : task.status === "failed" || task.status === "paused"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-foreground/80"
          }`}
        >
          {unread
            ? `${ATTEMPT_REVIEW_STATUS_LABEL[task.status]} · 未读`
            : ATTEMPT_REVIEW_STATUS_LABEL[task.status]}
        </span>
        <span>{shortTimeOf(task.createdAt)} 发起</span>
      </div>
      <p className="text-sm break-words">
        {origin !== undefined ? `${attemptOriginLineOf(origin)} · ` : ""}覆盖{" "}
        {task.questionCount} 题
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {primary !== null &&
          (origin !== undefined ? (
            <Button
              type="button"
              variant={unread ? "default" : "secondary"}
              className="min-h-11 px-3 text-sm"
              onClick={() => onOpen(task, primary.target)}
            >
              {primary.label}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              原练习已不可访问（可能已被移出或删除）
            </span>
          ))}
        {(["cancel", "retry", "archive"] as const)
          .filter((action) => task.allowedActions.includes(action))
          .map((action) => (
            <Button
              key={action}
              type="button"
              variant="ghost"
              className="min-h-11 px-3 text-sm"
              disabled={actionMutation.isPending}
              onClick={() =>
                actionMutation.mutate({
                  taskId: task.id,
                  attemptId: task.attemptId,
                  action,
                })
              }
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
      </div>
      {actionMutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          操作未生效：{errorMessageOf(actionMutation.error, "请稍后重试")}
        </p>
      )}
    </li>
  );
}

export function AiQueueReviewSection({
  query,
  tasks,
  onOpen,
}: {
  query: ReturnType<typeof useAttemptReviewQueue>;
  /** 当前范围内要显示的整卷任务（调用方已按「本次练习 / 全部来源」筛过） */
  tasks: readonly AiAttemptReviewTaskPublic[];
  onOpen: (task: AiAttemptReviewTaskPublic, target: string) => void;
}) {
  if (query.isError) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        整卷复盘记录加载失败：{errorMessageOf(query.error, "请稍后重试")}
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-2 text-sm"
          onClick={() => void query.refetch()}
        >
          重试
        </Button>
      </p>
    );
  }
  if (tasks.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">整卷复盘</h3>
      <ul className="flex flex-col gap-2" aria-label="整卷复盘任务列表">
        {tasks.map((task) => (
          <ReviewCard
            key={task.id}
            task={task}
            origin={query.data?.origins?.[task.id]}
            onOpen={onOpen}
          />
        ))}
      </ul>
      {query.data?.nextCursor != null && (
        <p className="text-xs text-muted-foreground">
          只显示最近 50 条整卷复盘记录。
        </p>
      )}
    </section>
  );
}
