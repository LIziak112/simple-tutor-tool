import { ListTodo, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AiQueuePanel } from "@/features/student-ai/AiQueuePanel";
import {
  aiQueueBadgeOf,
  useStudentAiQueueSummary,
} from "@/features/student-ai/ai-queue-queries";

/**
 * SAI-23 助教队列入口（B12；需求 §7.1）：顶栏按钮「队列」+ 双角标——
 * 待处理与新回复含义分开（不是一个角标双语义），数量为 0 不显示对应角标，
 * 加载中不显示数字（不把「未知」呈现成 0）。触控目标 ≥44px；窄屏只保留
 * 图标与角标，不挤掉同排的保存状态/退出操作。
 *
 * 抽屉打开时才挂载面板（列表查询按需发起）；关闭即卸载，不常驻轮询。
 * 连接配置入口不在此新增——快捷进设置统一走账号设置（/s/settings）。
 */

/** 单个角标徽片（count 为 0 或未知不渲染） */
function QueueBadge({
  label,
  count,
  tone,
}: {
  label: string;
  count: number | null;
  tone: "pending" | "unread";
}) {
  if (count === null || count === 0) return null;
  return (
    <span
      className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] leading-none font-semibold ${
        tone === "unread"
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-foreground/80"
      }`}
      title={`${label} ${count}`}
    >
      {count}
    </span>
  );
}

/** 队列入口按钮 + 抽屉（顶栏/作答页头部动作位共用） */
export function AiQueueButton() {
  const [open, setOpen] = useState(false);
  const summaryQuery = useStudentAiQueueSummary();
  const summary = summaryQuery.data;
  const badge = summary !== undefined ? aiQueueBadgeOf(summary) : null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="relative flex h-11 min-w-11 shrink-0 items-center gap-1.5 px-2"
        aria-label={
          badge !== null
            ? `助教队列：待处理 ${badge.pendingCount}，新回复 ${badge.unreadReplyCount}`
            : "助教队列"
        }
        title="助教队列"
        onClick={() => setOpen(true)}
      >
        {summaryQuery.isFetching && summary === undefined ? (
          <Loader2 aria-hidden className="size-5 animate-spin" />
        ) : (
          <ListTodo aria-hidden className="size-5" />
        )}
        <span className="hidden text-sm sm:inline">队列</span>
        {(badge?.pendingCount ?? 0) > 0 ||
        (badge?.unreadReplyCount ?? 0) > 0 ? (
          <span className="flex items-center gap-1" aria-hidden>
            <QueueBadge
              label="待处理"
              count={badge?.pendingCount ?? null}
              tone="pending"
            />
            <QueueBadge
              label="新回复"
              count={badge?.unreadReplyCount ?? null}
              tone="unread"
            />
          </span>
        ) : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:max-w-md"
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle className="text-left">助教队列</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <AiQueuePanel onNavigated={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
