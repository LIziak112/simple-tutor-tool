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
 * 服务端未放行时不渲染（不占位）。窄屏由 ResultWorkspace 放到顶栏第二行并
 * 占满整行。
 *
 * 报告读过以后入口仍在、名称仍是「查看整卷复盘报告」，但在窄屏收起：不再占
 * 第二行整行，变成图标组下方靠右的小按钮「复盘报告」（带图标与文字，点击
 * 区域仍有 44px 高）；宽屏不变。收起由本组件用 data-attempt-header-compact
 * 声明，ResultWorkspace 据此换位置。再发起一轮、或新报告未读时状态变了，
 * 自动回到整行。
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
  if (view.compact) {
    return (
      <Button
        type="button"
        variant="outline"
        // 窄屏看着是 32px 高的小按钮；before 伪元素把点击区域上下各外扩 6px（共
        // 44px。伪元素从 1px 边框内侧起算，所以写 7px）
        className="h-8 gap-1 px-2.5 text-xs before:absolute before:inset-x-0 before:-inset-y-[7px] lg:h-11 lg:gap-2 lg:px-4 lg:text-sm lg:before:hidden"
        // 可访问名称始终完整，不随宽度缩短
        aria-label={view.label}
        data-attempt-review-entry={state.kind}
        data-attempt-header-compact=""
        onClick={() => onOpen(view.target)}
      >
        <Icon aria-hidden className="size-3.5 lg:size-4" />
        <span className="lg:hidden">复盘报告</span>
        <span className="hidden lg:inline">{view.label}</span>
      </Button>
    );
  }
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
