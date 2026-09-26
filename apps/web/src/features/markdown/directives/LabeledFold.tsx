import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * 带标签的折叠块：fold / hint / answer / solution 在"教师端预览视角"下的
 * 共用交互件（T1.8 设计决策 3）。默认收起，点击标题展开；触控目标 ≥44px。
 */
type FoldTone = "neutral" | "secret";

const TONE_CLASSES: Record<FoldTone, string> = {
  neutral: "border-border bg-muted/40",
  secret:
    "border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
};

interface LabeledFoldProps {
  /** 折叠标题（如「提示 1」「最终答案」「详解」） */
  label: string;
  /** 左侧图标 */
  icon?: ReactNode;
  /** secret：教师侧机密内容（answer）用琥珀色标识 */
  tone?: FoldTone;
  children?: ReactNode;
}

export function LabeledFold({
  label,
  icon,
  tone = "neutral",
  children,
}: LabeledFoldProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("my-3 rounded-xl border", TONE_CLASSES[tone])}>
      {/* min-h-11 保证触控目标不小于 44px（UI 约定） */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {icon}
        <span>{label}</span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2 text-sm leading-7">
          {children}
        </div>
      ) : null}
    </div>
  );
}
