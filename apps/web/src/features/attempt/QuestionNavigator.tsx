import { ArrowRight, Check, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  completionLabel,
  type QuestionCompletion,
} from "./question-completion";

export interface QuestionNavigationItem {
  id: string;
  index: number;
  completion: QuestionCompletion;
  flagged: boolean;
}

export function QuestionNavigator({
  items,
  currentId,
  onJump,
}: {
  items: readonly QuestionNavigationItem[];
  currentId: string | null;
  onJump: (id: string) => void;
}) {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  // 从当前位置之后查找，卷尾回到前面；部分填写仍属于待补全。
  const next = [
    ...items.slice(currentIndex + 1),
    ...items.slice(0, currentIndex + 1),
  ].find((item) => item.completion.state !== "filled");
  return (
    <nav aria-label="答题卡" className="min-w-0">
      <Button
        type="button"
        variant="outline"
        className="mb-4 min-h-11 w-full justify-between px-3"
        disabled={!next}
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
      </div>
      <ol className="grid grid-cols-[repeat(auto-fill,44px)] justify-start gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-label={`第 ${item.index + 1} 题，${completionLabel(item.completion)}${item.flagged ? "，待检查" : ""}`}
              aria-current={item.id === currentId ? "location" : undefined}
              onClick={() => onJump(item.id)}
              className={`relative flex size-11 items-center justify-center rounded-md border text-sm font-medium tabular-nums outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${item.completion.state === "filled" ? "border-primary bg-primary text-primary-foreground" : item.completion.state === "partial" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground"} ${item.id === currentId ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
            >
              {item.index + 1}
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
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
