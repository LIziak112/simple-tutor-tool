import { cn } from "cn";
import { useContext } from "react";
import { blankAnswersContext } from "../BlankAnswersContext";
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
 * 填空空位。两种形态（T2.6 起双轨）：
 * - 纯展示（教师预览/讲义/结果视图）：下划线空框。标记内的参考答案是教师侧
 *   内容，一律不显示（T1.8 设计决策 2）；
 * - 作答形态（答题页提供了 BlankAnswersContext）：按空序编号渲染为内联输入框
 *   （触控目标 ≥44px，iPad 随手写可直接在框内转文字）。
 */
export function BlankDirective({ index }: DirectiveProps) {
  const answers = useContext(blankAnswersContext);
  if (answers !== null) {
    const blankIndex = Math.max(0, index - 1); // 编号 1 起 → 下标 0 起；未编号兜底第 1 空
    const value = answers.values[blankIndex] ?? "";
    return (
      <input
        type="text"
        inputMode="text"
        data-testid={`blank-${blankIndex + 1}`}
        aria-label={`第${blankIndex + 1}空`}
        value={value}
        disabled={answers.disabled}
        onChange={(event) => answers.onChange(blankIndex, event.target.value)}
        className="mx-1 inline-block h-11 w-28 max-w-full translate-y-[0.1em] rounded-md border-b-2 border-current bg-transparent px-2 align-middle text-inherit outline-none transition-colors focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-70"
      />
    );
  }
  return (
    <span
      data-testid="blank"
      role="img"
      aria-label="填空处"
      className="mx-1 inline-block h-[1em] w-16 min-w-16 translate-y-[0.15em] border-b-2 border-current opacity-70"
    />
  );
}
