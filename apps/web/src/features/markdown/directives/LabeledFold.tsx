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
  /**
   * 展开回调（仅收起 → 展开方向触发一次；T2.10 lecture_expand 埋点用，缺省 no-op）。
   * T4.0b 起新代码用 onToggle（双向）；本 prop 保留兼容。
   */
  onExpand?: (() => void) | undefined;
  /**
   * 开合回调（T4.0b，§5.0-C11）：open=收起→展开、close=展开→收起，
   * 每次点击恰好触发一次（与 onExpand 并存时两个都触发——onExpand 是
   * open 的旧形态别名，不影响新语义）。
   */
  onToggle?: ((action: "open" | "close") => void) | undefined;
  children?: ReactNode;
}

export function LabeledFold({
  label,
  icon,
  tone = "neutral",
  onExpand,
  onToggle,
  children,
}: LabeledFoldProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("my-3 rounded-xl border", TONE_CLASSES[tone])}>
      {/* min-h-11 保证触控目标不小于 44px（UI 约定） */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          // 回调放在 state updater 外执行（StrictMode 会双调 updater，内嵌会双发事件）
          const next = !open;
          if (next) onExpand?.();
          onToggle?.(next ? "open" : "close");
          setOpen(next);
        }}
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
