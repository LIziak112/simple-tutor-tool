import {
  answerDirective,
  blankDirective,
  boxDirective,
  colDirective,
  columnsDirective,
  type DirectiveDefinition,
  exampleDirective,
  foldDirective,
  getDirective,
  graphDirective,
  hintDirective,
  imageDirective,
  markDirective,
  questionDirective,
  solutionDirective,
  stepDirective,
  stepsDirective,
  tipDirective,
  warningDirective,
} from "@tutor/contract";
import { type ComponentType, createElement, type ReactNode } from "react";
import type { z } from "zod";
import { BoxDirective, TipDirective, WarningDirective } from "./Callout";
import { ColDirective, ColumnsDirective } from "./Columns";
import { BlankDirective, MarkDirective } from "./Inline";
import { GraphDirective, ImageDirective } from "./Media";
import { ExampleDirective, QuestionDirective } from "./Question";
import {
  AnswerDirective,
  FoldDirective,
  HintDirective,
  SolutionDirective,
  StepDirective,
  StepsDirective,
} from "./Steps";
import type { DirectiveBaseProps, DirectiveProps } from "./types";
import { UnknownDirective } from "./UnknownDirective";

/**
 * 指令 → React 组件 映射层（T1.8 设计决策 2；T7.2 起消费 Zod 属性解析）。
 *
 * 数据流：remarkDirectiveHost（remark 插件）把指令节点变成
 * directive-container / directive-leaf / directive-text 三个宿主标签并携带
 * { directive: 指令名, …属性 }；本文件导出的三个宿主组件接管这三个标签，
 * 按注册表（@tutor/contract）确认指令是否已支持：
 * - 已注册：查下表渲染对应组件（别名自动归一到主名组件），业务 attrs 先经
 *   该指令注册 schema 的 safeParse——类型化输出传组件，非法属性整体降级
 *   <UnknownDirective>（§4.1：属性合法性在渲染层得到校验，不抛异常）；
 * - 未注册：渲染 <UnknownDirective> 优雅降级（§5.1.1(3)），不报错不崩溃。
 *
 * 新增一个指令 = 注册表加定义 + 此表加一行 + 写组件（add-directive 技能四步）。
 */

/** 渲染器输入：宿主还原的原始字符串 attrs 与基础 props 分离传入 */
interface DirectiveRenderInput {
  readonly base: DirectiveBaseProps;
  readonly attrs: Readonly<Record<string, string>>;
}

/**
 * 一个指令的渲染器：schema 解析成功渲染组件；属性非法返回 null，
 * 宿主据此降级 UnknownDirective（正文保留）。
 */
export type DirectiveRenderer = (input: DirectiveRenderInput) => ReactNode;

/**
 * 把组件与其指令的属性 schema 绑定成渲染器（safeParse 的类型安全挂载点）：
 * 泛型在注册行上具体化——safeParse 输出类型与组件 props 的 attrs 类型由
 * 同一个 schema 推导，无 any、无强制断言；组件声明错 attrs 类型时编译即报错。
 */
function withTypedAttrs<TSchema extends z.ZodType>(
  definition: DirectiveDefinition<TSchema>,
  component: ComponentType<DirectiveProps<z.output<TSchema>>>,
): DirectiveRenderer {
  return ({ base, attrs }) => {
    const parsed = definition.attrs.safeParse(attrs);
    if (!parsed.success) return null; // 属性非法：宿主降级 UnknownDirective
    return createElement(component, { ...base, attrs: parsed.data });
  };
}

export const directiveComponents: Readonly<Record<string, DirectiveRenderer>> =
  {
    // 题目结构
    question: withTypedAttrs(questionDirective, QuestionDirective),
    hint: withTypedAttrs(hintDirective, HintDirective),
    answer: withTypedAttrs(answerDirective, AnswerDirective),
    solution: withTypedAttrs(solutionDirective, SolutionDirective),
    blank: withTypedAttrs(blankDirective, BlankDirective),
    // 讲义互动
    example: withTypedAttrs(exampleDirective, ExampleDirective),
    steps: withTypedAttrs(stepsDirective, StepsDirective),
    step: withTypedAttrs(stepDirective, StepDirective),
    fold: withTypedAttrs(foldDirective, FoldDirective),
    // 版式与强调
    tip: withTypedAttrs(tipDirective, TipDirective),
    warning: withTypedAttrs(warningDirective, WarningDirective),
    box: withTypedAttrs(boxDirective, BoxDirective),
    columns: withTypedAttrs(columnsDirective, ColumnsDirective),
    col: withTypedAttrs(colDirective, ColDirective),
    mark: withTypedAttrs(markDirective, MarkDirective),
    // 媒体
    image: withTypedAttrs(imageDirective, ImageDirective),
    graph: withTypedAttrs(graphDirective, GraphDirective),
  };

/** react-markdown 传给 components 的 hast 元素（本层只读 properties） */
interface HastElementLike {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

/** 宿主组件收到的 props（node 由 react-markdown 注入） */
interface DirectiveHostProps {
  node?: HastElementLike;
  children?: ReactNode;
}

/** 从 hast properties 还原指令信息 */
function readDirective(node: HastElementLike | undefined): {
  name: string;
  attrs: Record<string, string>;
  directiveClass: string | undefined;
  index: number;
  docIndex: number;
} {
  const properties = node?.properties ?? {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (
      key === "directive" ||
      key === "index" ||
      key === "dindex" ||
      key === "dclass"
    ) {
      continue;
    }
    if (typeof value === "string") attrs[key] = value;
    else if (typeof value === "number") attrs[key] = String(value);
  }
  const { directive, dclass, index, dindex } = properties;
  return {
    name: typeof directive === "string" ? directive : "",
    attrs,
    directiveClass: typeof dclass === "string" ? dclass : undefined,
    index: typeof index === "number" ? index : 0,
    docIndex: typeof dindex === "number" ? dindex : 0,
  };
}

function createDirectiveHost(inline: boolean) {
  function DirectiveHost({ node, children }: DirectiveHostProps) {
    const info = readDirective(node);
    // 别名经注册表归一到主名（§5.1.1(3) 改名兼容）
    const definition = getDirective(info.name);
    const primaryName = definition?.name ?? info.name;
    // 注册与组件映射均须命中；禁止从对象原型链取出“渲染器”。
    const render =
      definition !== undefined &&
      Object.hasOwn(directiveComponents, primaryName)
        ? directiveComponents[primaryName]
        : undefined;
    if (render === undefined) {
      return (
        <UnknownDirective name={info.name} inline={inline}>
          {children}
        </UnknownDirective>
      );
    }
    const base: DirectiveBaseProps = {
      name: primaryName,
      index: info.index,
      docIndex: info.docIndex,
      children,
      // exactOptionalPropertyTypes：仅在存在时携带该字段
      ...(info.directiveClass !== undefined
        ? { directiveClass: info.directiveClass }
        : {}),
    };
    // 属性经注册表 schema safeParse：非法（值越界、必填缺失、strict 拒绝
    // 跨指令串用键）时降级 UnknownDirective，与未知指令同路径保留正文。
    return (
      render({ base, attrs: info.attrs }) ?? (
        <UnknownDirective name={info.name} inline={inline}>
          {children}
        </UnknownDirective>
      )
    );
  }
  DirectiveHost.displayName = inline
    ? "DirectiveTextHost"
    : "DirectiveBlockHost";
  return DirectiveHost;
}

/** 容器指令（:::name … :::）的宿主组件 */
export const DirectiveContainerHost = createDirectiveHost(false);
/** 块指令（::name[文字]{属性}）的宿主组件 */
export const DirectiveLeafHost = createDirectiveHost(false);
/** 行内指令（:name[文字]{属性}）的宿主组件 */
export const DirectiveTextHost = createDirectiveHost(true);
