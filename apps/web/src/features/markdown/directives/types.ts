import type { ReactNode } from "react";

/**
 * 指令组件的宿主基础 props（由 DirectiveHost 从 hast properties 还原后传入，
 * T7.2 起 attrs 单独泛型化——见 DirectiveProps）。
 * 一个注册名一个组件，组件只关心这些字段，不接触 hast 细节。
 */
export interface DirectiveBaseProps {
  /** 指令名（注册表主名；别名已在映射层归一） */
  readonly name: string;
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

/**
 * 类型化指令组件的 props（T7.2）：attrs 是对应指令注册表 schema 的
 * safeParse 输出形态——缺省值已由 schema 填充（difficulty=2、color=yellow、
 * step 空串等），组件不再自行解析字符串/数字。类型从 contract 导出的
 * `XxxDirectiveAttrs` 取（勿手抄同形类型）；不读 attrs 的组件直接用
 * DirectiveBaseProps。
 */
export interface DirectiveProps<TAttrs> extends DirectiveBaseProps {
  /** 经注册表 schema 校验+解析后的业务属性（id/class 底座字段可缺省缺席） */
  readonly attrs: TAttrs;
}
