import { cn } from "cn";
import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 提示框族：tip（弱提示）/ warning（醒目警示）/ box（通用版式盒，按 .样式类 变体）。
 * 三者共用一套骨架，只差配色与默认标题。
 */
type CalloutVariant = "tip" | "warning" | "info" | "success" | "neutral";

const VARIANT_CLASSES: Record<CalloutVariant, string> = {
  tip: "border-sky-300 bg-sky-50 dark:border-sky-500/40 dark:bg-sky-500/10",
  warning:
    "border-amber-400 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
  info: "border-violet-300 bg-violet-50 dark:border-violet-500/40 dark:bg-violet-500/10",
  success:
    "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10",
  neutral: "border-border bg-muted/40",
};

const VARIANT_ICON_CLASSES: Record<CalloutVariant, string> = {
  tip: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-violet-600 dark:text-violet-400",
  success: "text-emerald-600 dark:text-emerald-400",
  neutral: "text-muted-foreground",
};

interface CalloutProps {
  variant: CalloutVariant;
  /** 标题为空时不渲染标题行（box 的 title 是可选项） */
  title?: string | undefined;
  children?: ReactNode;
}

export function Callout({ variant, title, children }: CalloutProps) {
  const Icon = variant === "warning" ? TriangleAlert : Info;
  return (
    <aside
      data-slot="callout"
      className={cn("my-3 rounded-xl border p-3", VARIANT_CLASSES[variant])}
    >
      {title ? (
        <p
          className={cn(
            "mb-1 flex items-center gap-1.5 text-sm font-semibold",
            VARIANT_ICON_CLASSES[variant],
          )}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
          {title}
        </p>
      ) : null}
      <div className="text-sm leading-7">{children}</div>
    </aside>
  );
}

/** :::tip 提示框，title 缺省显示「提示」 */
export function TipDirective({
  attrs,
  children,
}: {
  attrs: Readonly<Record<string, string>>;
  children?: ReactNode;
}) {
  return (
    <Callout variant="tip" title={attrs.title?.trim() || "提示"}>
      {children}
    </Callout>
  );
}

/** :::warning 警告框，title 缺省显示「注意」 */
export function WarningDirective({
  attrs,
  children,
}: {
  attrs: Readonly<Record<string, string>>;
  children?: ReactNode;
}) {
  return (
    <Callout variant="warning" title={attrs.title?.trim() || "注意"}>
      {children}
    </Callout>
  );
}

/** :::box 通用版式盒：.样式类（warning/info/success）决定外观，缺省中性 */
export function BoxDirective({
  attrs,
  directiveClass,
  children,
}: {
  attrs: Readonly<Record<string, string>>;
  directiveClass?: string;
  children?: ReactNode;
}) {
  const firstClass = directiveClass?.split(/\s+/).find((c) => c.length > 0);
  const variant: CalloutVariant =
    firstClass === "warning"
      ? "warning"
      : firstClass === "info"
        ? "info"
        : firstClass === "success"
          ? "success"
          : "neutral";
  const title = attrs.title?.trim();
  return (
    <Callout
      variant={variant}
      title={title && title.length > 0 ? title : undefined}
    >
      {children}
    </Callout>
  );
}
