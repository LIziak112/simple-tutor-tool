import { ArrowRight, Check, CircleHelp, Clock, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PracticeSubmittedMark } from "./PracticeWorkspace";
import {
  completionLabel,
  type QuestionCompletion,
} from "./question-completion";

export interface QuestionNavigationItem {
  id: string;
  index: number;
  completion: QuestionCompletion;
  flagged: boolean;
  /** #6980-4：做题时标了「不会」（服务端保存；题号导航用不同图标与待检查并存） */
  unsure?: boolean;
  /**
   * 逐题提交进度（M3-D1，v1 新协议卷）：submitted=服务端已确认提交；
   * feedbackReadable=当前节奏与教师 gate 是否允许读本题反馈。undefined =
   * 旧协议/讲练卷，维持原三态呈现（零变化）。统一公布模式下已提交行不得
   * 出现红绿对错或正确率暗示（§9.1），仅用中性图标与文字区分。
   */
  practice?: { submitted: boolean; feedbackReadable: boolean };
}

/** 单格的可达名：已提交行先报提交事实，不混入对错与得分 */
function itemLabel(item: QuestionNavigationItem): string {
  const state = item.practice?.submitted
    ? item.practice.feedbackReadable
      ? "已提交"
      : "已提交，反馈待公布"
    : completionLabel(item.completion);
  return `第 ${item.index + 1} 题，${state}${item.flagged ? "，待检查" : ""}${item.unsure ? "，标过不会" : ""}`;
}

/** 单格样式：已提交用中性前景色系（可读=浅底实线、待公布=灰底），非红绿 */
function itemClass(item: QuestionNavigationItem, current: boolean): string {
  const base =
    "relative flex size-11 items-center justify-center rounded-md border text-sm font-medium tabular-nums outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  const currentRing = current
    ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
    : "";
  if (item.practice?.submitted) {
    return `${base} ${item.practice.feedbackReadable ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-foreground/25 bg-muted text-muted-foreground"} ${currentRing}`;
  }
  const completion =
    item.completion.state === "filled"
      ? "border-primary bg-primary text-primary-foreground"
      : item.completion.state === "partial"
        ? "border-primary bg-primary/10 text-primary"
        : "border-border bg-card text-foreground";
  return `${base} ${completion} ${currentRing}`;
}

export function QuestionNavigator({
  items,
  currentId,
  onJump,
  locked = false,
}: {
  items: readonly QuestionNavigationItem[];
  currentId: string | null;
  onJump: (id: string) => void;
  /** 单题模式提交在途：跳题整体禁用（§7.2 busy 禁切题；列表模式不限滚动） */
  locked?: boolean;
}) {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  // 从当前位置之后查找，卷尾回到前面；部分填写仍属于待补全；
  // v1 卷已提交题不可再改答，「未答」同时要求未提交（§9.1 四态口径）。
  const next = [
    ...items.slice(currentIndex + 1),
    ...items.slice(0, currentIndex + 1),
  ].find(
    (item) => item.completion.state !== "filled" && !item.practice?.submitted,
  );
  const hasPractice = items.some((item) => item.practice !== undefined);
  return (
    <nav aria-label="答题卡" className="min-w-0">
      <Button
        type="button"
        variant="outline"
        className="mb-4 min-h-11 w-full justify-between px-3"
        disabled={locked || !next}
        onClick={() => next && onJump(next.id)}
      >
        {next ? "下一道未答" : items.length === 0 ? "暂无题目" : "全部已填写"}
        {next ? (
          <ArrowRight aria-hidden className="size-4" />
        ) : (
          <Check aria-hidden className="size-4" />
        )}
      </Button>
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>○ 未填写</span>
        <span>◐ 部分填写</span>
        <span>● 已填写</span>
        {hasPractice && (
          <>
            <span className="inline-flex items-center gap-1">
              <Check aria-hidden className="size-3" />
              已提交
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock aria-hidden className="size-3" />
              已提交 · 待公布
            </span>
          </>
        )}
      </div>
      {/* 为向外延伸 4px 的选中框和键盘焦点框留出空间，避免滚动容器裁切。 */}
      <ol className="grid grid-cols-[repeat(auto-fill,44px)] justify-start gap-2 p-1">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-label={itemLabel(item)}
              aria-current={item.id === currentId ? "location" : undefined}
              disabled={locked}
              onClick={() => onJump(item.id)}
              className={itemClass(item, item.id === currentId)}
            >
              {item.index + 1}
              {item.practice?.submitted && (
                <PracticeSubmittedMark
                  feedbackReadable={item.practice.feedbackReadable}
                />
              )}
              {item.completion.state === "partial" && (
                <span
                  aria-hidden
                  className="absolute bottom-1 h-0.5 w-3 bg-current"
                />
              )}
              {item.flagged && (
                <Flag
                  aria-hidden
                  className="absolute right-0.5 top-0.5 size-2.5"
                />
              )}
              {item.unsure && (
                <CircleHelp
                  aria-hidden
                  className="absolute bottom-0.5 right-0.5 size-2.5 text-amber-600 dark:text-amber-400"
                />
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
