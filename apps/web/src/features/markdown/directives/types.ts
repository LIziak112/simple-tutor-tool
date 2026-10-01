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
  /**
   * 文档全局指令序号（T4.0b，从 1 起；行内指令 mark/blank 不计）：全部块级指令
   * 按文档顺序的预序编号，directive_interact 的 payload index 用它——
   * 展示编号 index 按语义分别计数，无法区分同文档的多个 fold/steps 个体。
   * 与服务端解析（lecture-insights）按同一规则对账。
   */
  readonly docIndex: number;
  /** 指令内部内容（react-markdown 已渲染好的 React 子树） */
  children?: ReactNode;
}
