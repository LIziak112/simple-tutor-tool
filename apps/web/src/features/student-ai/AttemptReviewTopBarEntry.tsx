import {
  ClipboardList,
  FileText,
  Hourglass,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type AttemptReviewEntryState,
  attemptReviewEntryViewOf,
  useAttemptReviewEntry,
} from "./attempt-review-entry";

/**
 * 结果页顶栏的整卷复盘主按钮：任何宽度都带文字，文字随状态变化
 * （整卷复盘 → 等待领取 / 处理中 → 查看整卷复盘报告 → 需处理）。
 * 报告出来后常驻为「查看整卷复盘报告」，读过也不消失。服务端未放行时不渲染
 * （不占位）。窄屏由 ResultWorkspace 放到顶栏第二行并占满整行。
 */

const ICON_OF = {
  launch: ClipboardList,
  waiting: Hourglass,
  processing: Hourglass,
  report: FileText,
  attention: TriangleAlert,
} as const satisfies Record<
  Exclude<AttemptReviewEntryState["kind"], "unavailable">,
  typeof FileText
>;

export function AttemptReviewTopBarEntry({
  attemptId,
  released,
  onOpen,
}: {
  readonly attemptId: string;
  readonly released: boolean;
  /** 打开整卷复盘：target = "panel" 或某份报告的任务 id */
  readonly onOpen: (target: string) => void;
}) {
  const state = useAttemptReviewEntry(attemptId, released);
  const view = attemptReviewEntryViewOf(state);
  if (view === null || state.kind === "unavailable") return null;
  const Icon = ICON_OF[state.kind];
  return (
    <Button
      type="button"
      variant={view.tone === "primary" ? "default" : "outline"}
      className="h-11 w-full gap-2 px-4 text-sm sm:w-auto"
      data-attempt-review-entry={state.kind}
      onClick={() => onOpen(view.target)}
    >
      <Icon
        aria-hidden
        className={view.attention ? "size-4 text-destructive" : "size-4"}
      />
      {view.label}
      {view.unread && (
        <>
          <span
            aria-hidden
            className="rounded-full bg-primary-foreground px-1.5 py-0.5 text-[11px] leading-none font-semibold text-primary"
          >
            新
          </span>
          <span className="sr-only">（未读）</span>
        </>
      )}
    </Button>
  );
}
