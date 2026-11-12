import type {
  AiAttemptOriginSummary,
  AiTaskOriginSummary,
  AiTaskPublic,
} from "@tutor/contract";
import { type LucideIcon, MessageSquareReply } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { aiTaskStatusLabelOf } from "./ai-queue-groups";
import type { AiQueueAction } from "./ai-queue-queries";

/**
 * 「求助记录」卡片的共用件：类型标签、来源一行、时间短呈现、导航目标，以及
 * 逐题任务行（单题求助卡与批次卡展开后的逐题行同一个组件）。
 */

/** 来源中文名（导航说明与列表展示共用） */
function sourceLabelOf(
  sourceType: AiAttemptOriginSummary["sourceType"],
): string {
  switch (sourceType) {
    case "assignment":
      return "作业";
    case "course":
      return "课程练习";
    case "wrong":
      return "错题重练";
    case "lesson":
      return "讲练";
  }
}

/**
 * 来源一行：卷名 · 来源 · 第几次——从别的练习的记录点进去之前，就能确认是
 * 哪份卷的哪一次作答（wrong 来源没有卷名）。课程练习先写单元名（结果页的
 * 卷名），再写课程名：同一门课有多份练习，只写课程名分不清是哪一份。
 */
export function attemptOriginLineOf(origin: AiAttemptOriginSummary): string {
  return [
    ...(origin.unitTitle !== null ? [origin.unitTitle] : []),
    ...(origin.title !== null ? [origin.title] : []),
    sourceLabelOf(origin.sourceType),
    `第 ${origin.attemptNo} 次`,
  ].join(" · ");
}

/**
 * 队列项导航目标（attempt 级定位）：course/wrong 按本 attempt 直达（旧卷
 * 不跳新卷）；assignment 进作业入口页（单卷幂等）；lesson 进讲练落地页
 * （create-or-return 绝不开新卷）。缺导航键（如卷已删）→ null 呈现说明。
 */
export function aiQueueTargetOf(
  task: AiTaskPublic,
  origin: AiTaskOriginSummary | undefined,
): string | null {
  if (origin === undefined) return null;
  switch (origin.sourceType) {
    case "assignment":
      return task.attemptId !== ""
        ? `/s/attempts/${encodeURIComponent(task.attemptId)}`
        : null;
    case "course":
    case "wrong":
      return `/s/attempts/${encodeURIComponent(task.attemptId)}`;
    case "lesson":
      return task.attemptId !== ""
        ? `/s/attempts/${encodeURIComponent(task.attemptId)}`
        : null;
  }
}

/** 时间短呈现（MM-DD HH:mm；同年省年份，列表行内紧凑） */
export function shortTimeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 任务类型标签（图标 + 文字，不只靠颜色区分） */
export function QueueTypeTag({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs font-medium text-foreground/80">
      <Icon aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}

export type AiQueueNavigate = (
  task: AiTaskPublic,
  origin: AiTaskOriginSummary | undefined,
  openReply?: boolean,
) => void;

/** 逐题任务行（状态/时间/题号/来源 + 与 allowedActions 对齐的操作） */
export function AiQueueItem({
  task,
  origin,
  typeTag,
  onNavigate,
  onAction,
  actionPending,
}: {
  task: AiTaskPublic;
  origin: AiTaskOriginSummary | undefined;
  /** 类型标签（单题求助卡传入；批次卡里的逐题行由批次卡统一标注，不重复） */
  typeTag?: ReactNode;
  onNavigate: AiQueueNavigate;
  onAction: (taskId: string, action: AiQueueAction) => void;
  actionPending: boolean;
}) {
  const metaParts: string[] = [
    origin?.questionNo !== null && origin?.questionNo !== undefined
      ? `第 ${origin.questionNo} 题`
      : "题目已不在卷内",
  ];
  if (origin !== undefined) metaParts.push(attemptOriginLineOf(origin));
  const target = aiQueueTargetOf(task, origin);
  const actions: { action: AiQueueAction; label: string }[] = [];
  if (task.allowedActions.includes("cancel"))
    actions.push({ action: "cancel", label: "取消" });
  if (task.allowedActions.includes("retry"))
    actions.push({ action: "retry", label: "重试" });
  if (task.allowedActions.includes("resume"))
    actions.push({ action: "resume", label: "继续" });
  if (task.allowedActions.includes("archive"))
    actions.push({ action: "archive", label: "归档" });
  const unread = task.status === "replied" && task.replyDeliveredAt === null;
  return (
    <li className="rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          disabled={target === null}
          onClick={() => onNavigate(task, origin, true)}
        >
          <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {typeTag}
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${
                unread
                  ? "bg-primary/15 text-primary"
                  : task.status === "failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-foreground/80"
              }`}
            >
              {aiTaskStatusLabelOf(task.status)}
            </span>
            <span>{shortTimeOf(task.createdAt)}</span>
            <span className="min-w-0 truncate">{metaParts.join(" · ")}</span>
          </span>
          <span className="line-clamp-2 w-full text-sm break-words">
            {task.question}
          </span>
        </button>
        {unread && (
          <span
            className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
            title="有新回复未读"
          >
            <MessageSquareReply aria-hidden className="size-4" />
            <span className="sr-only">有新回复未读</span>
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {target !== null ? (
          <>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 px-3 text-sm"
              onClick={() => onNavigate(task, origin)}
            >
              回到本题
            </Button>
            {task.status === "replied" && (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 px-3 text-sm"
                onClick={() => onNavigate(task, origin, true)}
              >
                查看回复
              </Button>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            原练习已不可访问（可能已被移出或删除）
          </span>
        )}
        {actions.map(({ action, label }) => (
          <Button
            key={action}
            type="button"
            variant="ghost"
            className="min-h-11 px-3 text-sm"
            disabled={actionPending}
            onClick={() => onAction(task.id, action)}
          >
            {label}
          </Button>
        ))}
      </div>
    </li>
  );
}
