import type { ReactNode } from "react";

/**
 * 指令组件的统一 props（由 DirectiveHost 从 hast properties 还原后传入）。
 * 一个注册名一个组件，组件只关心这四个字段，不接触 hast 细节。
 */
export interface DirectiveProps {
  /** 指令名（注册表主名；别名已在映射层归一） */
  readonly name: string;
  /** 指令属性（remark-directive 解析出的字符串键值；已剔除 id/class） */
  readonly attrs: Readonly<Record<string, string>>;
  /** `{.样式类}` 简写解析出的样式类（box 等按此选择外观变体） */
  readonly directiveClass?: string;
  /** 文档顺序编号：question=第 N 题、hint=提示 N、step=第 N 步；未编号为 0 */
  readonly index: number;
  /** 指令内部内容（react-markdown 已渲染好的 React 子树） */
  children?: ReactNode;
}
