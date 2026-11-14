import { ChevronDown, ChevronUp, ListPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePortalRoutes } from "@/features/runtime/portal-runtime";
import {
  AiQueueItem,
  type AiQueueNavigate,
  aiQueueTargetOf,
  attemptOriginLineOf,
  QueueTypeTag,
  shortTimeOf,
} from "./AiQueueItem";
import {
  type AiQueueEntry,
  aiTaskStatusLabelOf,
  batchProgressTextOf,
} from "./ai-queue-groups";
import type { AiQueueAction } from "./ai-queue-queries";

/**
 * 批量复盘批次卡：同一次「批量复盘」创建的逐题任务合成一张卡——卡头写明
 * 来源（哪份卷的哪一次、什么时候发起、不是整卷复盘），中间是进度汇总和每题
 * 一个状态按钮（点了回到那道题 / 看那道题的回复），逐题的取消、重试、归档
 * 收在「展开逐题操作」里。只读：展开、收起、看状态都不改任何任务。
 */
export function AiQueueBatchCard({
  entry,
  onNavigate,
  onAction,
  actionPending,
}: {
  entry: Extract<AiQueueEntry, { kind: "batch" }>;
  onNavigate: AiQueueNavigate;
  onAction: (taskId: string, action: AiQueueAction) => void;
  actionPending: boolean;
}) {
  const routes = usePortalRoutes();

  const [expanded, setExpanded] = useState(false);
  const { batch, items } = entry;
  const first = items[0];
  if (first === undefined) return null;
  const tasks = items.map((item) => item.task);
  return (
    <li
      data-testid="ai-queue-batch"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <QueueTypeTag icon={ListPlus}>批量复盘错题</QueueTypeTag>
        <span className="font-medium text-foreground">
          {batch.taskCount === items.length
            ? `${items.length} 题`
            : `本批共 ${batch.taskCount} 题，当前显示 ${items.length} 题`}
        </span>
        <span>{shortTimeOf(batch.createdAt)} 发起</span>
      </div>
      <p className="text-sm break-words">{attemptOriginLineOf(first.origin)}</p>
      <p className="text-xs text-muted-foreground">
        同一次批量复盘创建，每题一条独立任务，不是整卷复盘。
      </p>
      <p className="text-sm font-medium">{batchProgressTextOf(tasks)}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ task, origin }) => {
          const questionLabel =
            origin.questionNo !== null
              ? `第 ${origin.questionNo} 题`
              : "题目已不在卷内";
          const statusLabel = aiTaskStatusLabelOf(task.status);
          const replied = task.status === "replied";
          const unread = replied && task.replyDeliveredAt === null;
          return (
            <Button
              key={task.id}
              type="button"
              variant="outline"
              className={`h-auto min-h-11 flex-col gap-0 px-2.5 py-1 text-xs ${
                unread ? "border-primary/50 bg-primary/5" : ""
              }`}
              disabled={aiQueueTargetOf(routes, task, origin) === null}
              aria-label={`${questionLabel}：${statusLabel}，${replied ? "查看回复" : "回到本题"}`}
              onClick={() => onNavigate(task, origin, replied)}
            >
              <span className="font-medium">{questionLabel}</span>
              <span
                className={unread ? "text-primary" : "text-muted-foreground"}
              >
                {unread ? "新回复" : statusLabel}
              </span>
            </Button>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 self-start px-2 text-sm text-muted-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronUp aria-hidden className="size-4" />
        ) : (
          <ChevronDown aria-hidden className="size-4" />
        )}
        {expanded ? "收起逐题操作" : "展开逐题操作"}
      </Button>
      {expanded && (
        <ul className="flex flex-col gap-2" aria-label="本批逐题任务">
          {items.map(({ task, origin }) => (
            <AiQueueItem
              key={task.id}
              task={task}
              origin={origin}
              onNavigate={onNavigate}
              onAction={onAction}
              actionPending={actionPending}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
