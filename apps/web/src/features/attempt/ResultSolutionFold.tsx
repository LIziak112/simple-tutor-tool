import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

// 轻量呈现件拆至 AttemptResultParts（草稿视图的逐题反馈静态引用它们，不得
// 把本重模块拖进作答页）；此处对外再导出，既有调用方不受影响。

export function SolutionFold({
  solutionMd,
  onToggle,
  renderLayout,
  enabled = true,
}: {
  solutionMd: string | null;
  onToggle?: ((action: "open" | "close") => void) | undefined;
  /** 结果页将入口放入统一操作行，其余调用方沿用折叠布局。 */
  renderLayout?: (trigger: ReactNode, content: ReactNode) => ReactNode;
  /** 公布前隐藏详解，保持统一布局内的材料控制器挂载。 */
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled) return renderLayout?.(null, null) ?? null;
  if (solutionMd === null) {
    const absent = (
      <p className="text-sm text-muted-foreground">这道题没有详解。</p>
    );
    return renderLayout ? renderLayout(absent, null) : absent;
  }
  const trigger = (
    <Button
      variant="outline"
      className="min-h-11 w-fit shrink-0 whitespace-nowrap"
      aria-expanded={open}
      onClick={() => {
        const next = !open;
        onToggle?.(next ? "open" : "close");
        setOpen(next);
      }}
    >
      查看详解
      <ChevronDown
        aria-hidden
        className={cn("size-4 transition-transform", open && "rotate-180")}
      />
    </Button>
  );
  const content = open ? (
    <div className="border-s-2 border-border ps-3">
      <RichMarkdown source={solutionMd} className="text-sm" />
    </div>
  ) : null;
  return renderLayout ? (
    renderLayout(trigger, content)
  ) : (
    <div className="flex flex-col gap-2">
      {trigger}
      {content}
    </div>
  );
}
