import type { AiTaskOriginSummary, AiTaskPublic } from "@tutor/contract";
import { Loader2, MessageSquareReply, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  type AiQueueAction,
  aiQueueBadgeOf,
  useStudentAiQueue,
  useStudentAiQueueAction,
  useStudentAiQueueSummary,
} from "@/features/student-ai/ai-queue-queries";
import { errorMessageOf } from "@/features/student-ai/error-text";

/**
 * SAI-23 助教队列面板（B12；需求 §7.1/§8）。列表载荷只含展示与导航定位
 * 字段——对话正文与材料只在授权详情接口读取（抽屉内不拉详情，点任务去
 * 原作答页由伴学栏按 SAI-20/21 语义打开）。
 *
 * 语义要点：
 * - 待处理与新回复两个角标含义分开（aiQueueBadgeOf 单源派生）；
 * - 操作按钮与任务行服务端 allowedActions 严格对齐（客户端不本地查表），
 *   归档≠已读、取消≠已读（角标与已读态都不因这两者错动）；
 * - 点任务主体导航到原作答（attempt 级定位——旧卷同 questionId 不跳新卷；
 *   lesson 跳幂等落地页不开新卷），aiFrom 携带当前页面完整位置，目标页
 *   「返回原页面」可回到打开队列时的来源位置；
 * - 新任务/回信到达只刷新本列表与角标，不自动导航、不自动切题。
 */

/** 处理状态徽标短文案（列表用；对话面板的完整文案在 AiConversationPanel） */
function statusLabelOf(status: AiTaskPublic["status"]): string {
  switch (status) {
    case "created":
      return "待领取";
    case "dispatching":
      return "发送中";
    case "uncertain":
      return "待确认";
    case "claimed":
      return "处理中";
    case "replied":
      return "已回复";
    case "paused":
      return "已暂停";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

/** 来源中文名（导航说明与列表展示共用） */
function sourceLabelOf(sourceType: AiTaskOriginSummary["sourceType"]): string {
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
      return origin.assignmentId !== null
        ? `/s/assignments/${encodeURIComponent(origin.assignmentId)}`
        : null;
    case "course":
    case "wrong":
      return `/s/attempts/${encodeURIComponent(task.attemptId)}`;
    case "lesson":
      return origin.lectureId !== null
        ? `/s/lectures/${encodeURIComponent(origin.lectureId)}/lesson`
        : null;
  }
}

/** 时间短呈现（MM-DD HH:mm；同年省年份，列表行内紧凑） */
function shortTimeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 队列项行（状态/时间/题号/来源 + 与 allowedActions 对齐的操作） */
function AiQueueItem({
  task,
  origin,
  onNavigate,
  onAction,
  actionPending,
}: {
  task: AiTaskPublic;
  origin: AiTaskOriginSummary | undefined;
  onNavigate: (
    task: AiTaskPublic,
    origin: AiTaskOriginSummary | undefined,
  ) => void;
  onAction: (taskId: string, action: AiQueueAction) => void;
  actionPending: boolean;
}) {
  const metaParts: string[] = [
    origin?.questionNo !== null && origin?.questionNo !== undefined
      ? `第 ${origin.questionNo} 题`
      : "题目已不在卷内",
  ];
  if (origin !== undefined) {
    metaParts.push(sourceLabelOf(origin.sourceType));
    if (origin.title !== null) metaParts.push(origin.title);
  }
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
  return (
    <li className="rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => onNavigate(task, origin)}
        >
          <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${
                task.status === "replied" && task.replyDeliveredAt === null
                  ? "bg-primary/15 text-primary"
                  : task.status === "failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-foreground/80"
              }`}
            >
              {statusLabelOf(task.status)}
            </span>
            <span>{shortTimeOf(task.createdAt)}</span>
            <span className="min-w-0 truncate">{metaParts.join(" · ")}</span>
          </span>
          <span className="line-clamp-2 w-full text-sm break-words">
            {task.question}
          </span>
        </button>
        {task.status === "replied" && task.replyDeliveredAt === null && (
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
          <Button
            type="button"
            variant="secondary"
            className="min-h-9 px-3 text-xs"
            onClick={() => onNavigate(task, origin)}
          >
            {task.status === "replied" ? "查看回复" : "回到本题"}
          </Button>
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
            className="min-h-9 px-3 text-xs"
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

/** 队列面板主体（放抽屉/独立视图共用；分组 = 归档三态的 exclude/only 两面） */
export function AiQueuePanel({ onNavigated }: { onNavigated?: () => void }) {
  const [group, setGroup] = useState<"active" | "archived">("active");
  const archived = group === "active" ? "exclude" : "only";
  const summaryQuery = useStudentAiQueueSummary();
  const listQuery = useStudentAiQueue(archived);
  const actionMutation = useStudentAiQueueAction();
  const navigate = useNavigate();
  const location = useLocation();

  const summary = summaryQuery.data;
  const badge = summary !== undefined ? aiQueueBadgeOf(summary) : null;
  const pages = listQuery.data?.pages ?? [];
  const tasks = pages.flatMap((page) => page.tasks);

  const handleNavigate = (
    task: AiTaskPublic,
    origin: AiTaskOriginSummary | undefined,
  ) => {
    const target = aiQueueTargetOf(task, origin);
    if (target === null) return;
    // 返回来源位置：携带当前完整位置（含筛选 query），目标页返回时回这里
    const from = location.pathname + location.search;
    onNavigated?.();
    void navigate(
      `${target}${target.includes("?") ? "&" : "?"}aiFrom=${encodeURIComponent(from)}`,
    );
  };

  const handleAction = (taskId: string, action: AiQueueAction) => {
    actionMutation.mutate({ taskId, action });
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {badge !== null ? (
          <>
            <span>
              待处理 <span className="font-semibold">{badge.pendingCount}</span>
            </span>
            <span>
              新回复{" "}
              <span className="font-semibold">{badge.unreadReplyCount}</span>
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">正在获取队列数量…</span>
        )}
        {summaryQuery.isError && (
          <span role="alert" className="text-xs text-destructive">
            队列数量获取失败：{errorMessageOf(summaryQuery.error, "请稍后重试")}
            <Button
              type="button"
              variant="ghost"
              className="ml-1 min-h-9 px-2 text-xs"
              onClick={() => void summaryQuery.refetch()}
            >
              重试
            </Button>
          </span>
        )}
      </div>
      <div
        role="tablist"
        aria-label="队列分组"
        className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
      >
        {(
          [
            ["active", "进行中"],
            ["archived", "已归档"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={group === key}
            className={`flex min-h-11 items-center justify-center rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
              group === key
                ? "bg-card text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setGroup(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {actionMutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          操作未生效：{errorMessageOf(actionMutation.error, "请稍后重试")}
        </p>
      )}
      {listQuery.isPending ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在载入队列…
        </div>
      ) : listQuery.isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 py-6 text-sm"
        >
          <p className="text-destructive">
            队列加载失败：{errorMessageOf(listQuery.error, "请稍后重试")}
          </p>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 px-4"
            onClick={() => void listQuery.refetch()}
          >
            <RefreshCw aria-hidden className="size-4" />
            重新加载
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {group === "active"
            ? "队列为空——在题目旁的「AI 助教」发起求助后，任务会出现在这里"
            : "还没有已归档的任务"}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label="助教任务列表">
            {tasks.map((task) => (
              <AiQueueItem
                key={task.id}
                task={task}
                origin={
                  pages.find((page) => page.origins?.[task.id] !== undefined)
                    ?.origins?.[task.id]
                }
                onNavigate={handleNavigate}
                onAction={handleAction}
                actionPending={actionMutation.isPending}
              />
            ))}
          </ul>
          {listQuery.hasNextPage && (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={!listQuery.hasNextPage || listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? (
                <>
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                  正在载入更多…
                </>
              ) : (
                "加载更多"
              )}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
