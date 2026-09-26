import { cn } from "cn";
import type { DirectiveProps } from "./types";

/**
 * 行内指令：:mark[文字]{color=…} 荧光笔重点标记、[[…]] 填空空框（blank 语法糖）。
 */

/** mark 的高亮颜色（color 属性取值与注册表 schema 一致，缺省 yellow） */
const MARK_COLORS: Readonly<Record<string, string>> = {
  yellow: "bg-yellow-200 dark:bg-yellow-400/30",
  red: "bg-red-200 dark:bg-red-400/30",
  blue: "bg-blue-200 dark:bg-blue-400/30",
  green: "bg-green-200 dark:bg-green-400/30",
};

export function MarkDirective({ attrs, children }: DirectiveProps) {
  const color = MARK_COLORS[attrs.color ?? "yellow"] ?? MARK_COLORS.yellow;
  return (
    <mark className={cn("rounded-sm px-0.5 text-inherit", color)}>
      {children}
    </mark>
  );
}

/**
 * 填空空位（教师预览视角）：`[[答案]]` 只渲染为下划线空框，
 * 标记内的参考答案是教师侧内容，一律不显示（T1.8 设计决策 2）。
 */
export function BlankDirective() {
  return (
    <span
      data-testid="blank"
      role="img"
      aria-label="填空处"
      className="mx-1 inline-block h-[1em] w-16 min-w-16 translate-y-[0.15em] border-b-2 border-current opacity-70"
    />
  );
}
