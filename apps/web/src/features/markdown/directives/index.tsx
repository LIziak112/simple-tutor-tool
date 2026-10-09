import { getDirective } from "@tutor/contract";
import type { ComponentType, ReactNode } from "react";
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
import type { DirectiveProps } from "./types";
import { UnknownDirective } from "./UnknownDirective";

/**
 * 指令 → React 组件 映射层（T1.8 设计决策 2）。
 *
 * 数据流：remarkDirectiveHost（remark 插件）把指令节点变成
 * directive-container / directive-leaf / directive-text 三个宿主标签并携带
 * { directive: 指令名, …属性 }；本文件导出的三个宿主组件接管这三个标签，
 * 按注册表（@tutor/contract）确认指令是否已支持：
 * - 已注册：查下表渲染对应组件（别名自动归一到主名组件）；
 * - 未注册：渲染 <UnknownDirective> 优雅降级（§5.1.1(3)），不报错不崩溃。
 *
 * 新增一个指令 = 注册表加定义 + 此表加一行 + 写组件（add-directive 技能四步）。
 */
export const directiveComponents: Readonly<
  Record<string, ComponentType<DirectiveProps>>
> = {
  // 题目结构
  question: QuestionDirective,
  hint: HintDirective,
  answer: AnswerDirective,
  solution: SolutionDirective,
  blank: BlankDirective,
  // 讲义互动
  example: ExampleDirective,
  steps: StepsDirective,
  step: StepDirective,
  fold: FoldDirective,
  // 版式与强调
  tip: TipDirective,
  warning: WarningDirective,
  box: BoxDirective,
  columns: ColumnsDirective,
  col: ColDirective,
  mark: MarkDirective,
  // 媒体
  image: ImageDirective,
  graph: GraphDirective,
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
    // 注册与组件映射均须命中；禁止从对象原型链取出“组件”。
    const Component =
      definition !== undefined &&
      Object.hasOwn(directiveComponents, primaryName)
        ? directiveComponents[primaryName]
        : undefined;
    if (Component === undefined) {
      return (
        <UnknownDirective name={info.name} inline={inline}>
          {children}
        </UnknownDirective>
      );
    }
    const props: DirectiveProps = {
      name: primaryName,
      attrs: info.attrs,
      index: info.index,
      docIndex: info.docIndex,
      children,
      // exactOptionalPropertyTypes：仅在存在时携带该字段
      ...(info.directiveClass !== undefined
        ? { directiveClass: info.directiveClass }
        : {}),
    };
    return <Component {...props} />;
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
