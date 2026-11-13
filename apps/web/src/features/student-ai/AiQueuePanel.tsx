import type {
  AiAttemptReviewTaskPublic,
  AiTaskOriginSummary,
  AiTaskPublic,
} from "@tutor/contract";
import { Loader2, MessageCircleQuestion, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { AiQueueBatchCard } from "@/features/student-ai/AiQueueBatchCard";
import {
  AiQueueItem,
  aiQueueTargetOf,
  QueueTypeTag,
} from "@/features/student-ai/AiQueueItem";
import { AiQueueReviewSection } from "@/features/student-ai/AiQueueReviewSection";
import { aiQueueEntriesOf } from "@/features/student-ai/ai-queue-groups";
import {
  type AiQueueAction,
  aiQueueBadgeOf,
  useStudentAiQueue,
  useStudentAiQueueAction,
  useStudentAiQueueSummary,
} from "@/features/student-ai/ai-queue-queries";
import {
  ATTEMPT_REVIEW_PARAM,
  attemptReviewHref,
} from "@/features/student-ai/attempt-review-entry";
import { useAttemptReviewQueue } from "@/features/student-ai/attempt-review-queue";
import { errorMessageOf } from "@/features/student-ai/error-text";

/**
 * SAI-23 助教队列面板（B12；需求 §7.1/§8）。列表载荷只含展示与导航定位
 * 字段——对话正文与材料只在授权详情接口读取（抽屉内不拉详情，点任务去
 * 原作答页由伴学栏按 SAI-20/21 语义打开）。
 *
 * 呈现：分两段——「整卷复盘」（每条整卷任务一张卡）与「逐题求助」（同一次
 * 批量复盘的任务合成一张批次卡，单题求助各自一行）；类型用图标 + 文字标签
 * 区分。浏览、展开、看进度只读，不取任何正文、不记已读。
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

/** 队列面板主体（放抽屉/独立视图共用；分组 = 归档三态的 exclude/only 两面） */
export interface AiQueueNavigationProps {
  currentAttemptId?: string | undefined;
  onOpenTask?: ((task: AiTaskPublic) => Promise<boolean>) | undefined;
  onOpenQuestion?: ((task: AiTaskPublic) => Promise<boolean>) | undefined;
  onOpenAttemptReview?: (target: string) => void;
}
export function AiQueuePanel({
  onNavigated,
  currentAttemptId,
  onOpenTask,
  onOpenQuestion,
  onOpenAttemptReview,
}: AiQueueNavigationProps & { onNavigated?: () => void }) {
  const [group, setGroup] = useState<"active" | "archived">("active");
  const [scope, setScope] = useState<"current" | "all">(
    currentAttemptId ? "current" : "all",
  );
  const [opening, setOpening] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const archived = group === "active" ? "exclude" : "only";
  const summaryQuery = useStudentAiQueueSummary();
  const listQuery = useStudentAiQueue(archived);
  const actionMutation = useStudentAiQueueAction();
  const navigate = useNavigate();
  const location = useLocation();

  const summary = summaryQuery.data;
  const badge = summary !== undefined ? aiQueueBadgeOf(summary) : null;
  const pages = listQuery.data?.pages ?? [];
  const inScope = (task: { attemptId: string }) =>
    scope === "all" || task.attemptId === currentAttemptId;
  const tasks = pages.flatMap((page) => page.tasks).filter(inScope);
  const entries = aiQueueEntriesOf(
    tasks,
    (taskId) =>
      pages.find((page) => page.origins?.[taskId] !== undefined)?.origins?.[
        taskId
      ],
  );
  const reviewQuery = useAttemptReviewQueue(
    archived,
    scope === "current" ? currentAttemptId : undefined,
  );
  const reviewTasks = reviewQuery.data?.tasks ?? [];

  /** 来源位置（目标页「返回原页面」用）：当前完整位置去掉一次性的打开参数 */
  const sourceLocation = () => {
    const source = new URL(
      location.pathname + location.search,
      "https://student.invalid",
    );
    for (const key of [
      "aiFrom",
      "aiTask",
      "aiQuestion",
      "aiCompose",
      ATTEMPT_REVIEW_PARAM,
    ])
      source.searchParams.delete(key);
    return source.pathname + source.search;
  };

  const handleNavigate = async (
    task: AiTaskPublic,
    origin: AiTaskOriginSummary | undefined,
    openReply = false,
  ) => {
    if (opening) return;
    const target = aiQueueTargetOf(task, origin);
    if (target === null) return;
    const openInPlace = openReply ? onOpenTask : onOpenQuestion;
    if (task.attemptId === currentAttemptId && openInPlace) {
      setOpening(true);
      try {
        if (await openInPlace(task)) onNavigated?.();
        else
          setNavigationError(
            "暂时无法打开本题，请先完成材料恢复或重试保存，再点这条记录。",
          );
      } catch {
        setNavigationError("打开失败，请检查本机材料保存状态后重试。");
      } finally {
        setOpening(false);
      }
      return;
    }
    // 返回来源位置：携带当前完整位置（含筛选 query），目标页返回时回这里
    const from = sourceLocation();
    onNavigated?.();
    const targetParams = new URLSearchParams({
      aiFrom: from,
      aiQuestion: task.questionId,
    });
    if (openReply) targetParams.set("aiTask", task.id);
    void navigate(`${target}?${targetParams}`);
  };

  /**
   * 打开整卷复盘（报告或进度面板）：只按任务自己的 attemptId 去那次作答的
   * 结果页，由结果页按地址打开——和顶栏入口是同一个位置。已经在那次作答的
   * 结果页上就原地打开（保留当前位置与既有回程；和顶栏入口同一套历史规则，
   * 后退先关报告），否则带上来源位置。
   */
  const handleOpenReview = (
    task: AiAttemptReviewTaskPublic,
    target: string,
  ) => {
    onNavigated?.();
    if (task.attemptId === currentAttemptId && onOpenAttemptReview) {
      onOpenAttemptReview(target);
      return;
    }
    void navigate(attemptReviewHref(task.attemptId, target, sourceLocation()));
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
              className="ml-1 min-h-11 px-2 text-xs"
              onClick={() => void summaryQuery.refetch()}
            >
              重试
            </Button>
          </span>
        )}
      </div>
      {currentAttemptId && (
        <fieldset className="flex flex-wrap gap-2" aria-label="求助记录范围">
          <Button
            type="button"
            variant={scope === "current" ? "secondary" : "ghost"}
            aria-pressed={scope === "current"}
            className="min-h-11"
            onClick={() => setScope("current")}
          >
            本次练习
          </Button>
          <Button
            type="button"
            variant={scope === "all" ? "secondary" : "ghost"}
            aria-pressed={scope === "all"}
            className="min-h-11"
            onClick={() => setScope("all")}
          >
            全部来源
          </Button>
        </fieldset>
      )}
      {navigationError && (
        <p role="alert" className="text-sm text-destructive">
          {navigationError}
        </p>
      )}
      {opening && (
        <p role="status" className="text-sm">
          正在保存并打开本题…
        </p>
      )}
      <div
        role="tablist"
        aria-label="队列分组"
        className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
      >
        {(
          [
            ["active", "未归档"],
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
      ) : (
        <>
          <AiQueueReviewSection
            query={reviewQuery}
            tasks={reviewTasks}
            onOpen={handleOpenReview}
          />
          {tasks.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">逐题求助</h3>
              <ul className="flex flex-col gap-2" aria-label="助教任务列表">
                {entries.map((entry) =>
                  entry.kind === "batch" ? (
                    <AiQueueBatchCard
                      key={entry.batch.id}
                      entry={entry}
                      onNavigate={handleNavigate}
                      onAction={handleAction}
                      actionPending={actionMutation.isPending}
                    />
                  ) : (
                    <AiQueueItem
                      key={entry.task.id}
                      task={entry.task}
                      origin={entry.origin}
                      typeTag={
                        <QueueTypeTag icon={MessageCircleQuestion}>
                          单题求助
                        </QueueTypeTag>
                      }
                      onNavigate={handleNavigate}
                      onAction={handleAction}
                      actionPending={actionMutation.isPending}
                    />
                  ),
                )}
              </ul>
            </section>
          ) : (
            reviewTasks.length === 0 &&
            !reviewQuery.isPending && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {group === "active"
                  ? scope === "current"
                    ? "当前已加载记录中没有本次练习的求助，可加载更多或切换全部来源。"
                    : "队列为空——在题目旁的「AI 助教」发起求助后，任务会出现在这里"
                  : "还没有已归档的任务"}
              </p>
            )
          )}
        </>
      )}
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
    </div>
  );
}
