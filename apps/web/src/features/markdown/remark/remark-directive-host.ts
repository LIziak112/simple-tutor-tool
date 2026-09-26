import type { DirectiveNode, DirectiveNodeType, MdNode } from "./mdast-interop";
import { isDirectiveNode } from "./mdast-interop";

/**
 * remark 插件：把指令节点（remark-directive 产出）映射为自定义 hast 元素，
 * 供 react-markdown 的 components 按标签名接管渲染（T1.8 设计决策 1/2）。
 *
 * 机制：remark-rehype 官方支持 data.hName / data.hProperties——
 * 任何 mdast 节点设置了这两个字段，输出元素就用指定的标签名与属性。
 * 三种指令写法对应三个宿主标签：
 *   containerDirective → directive-container（块级）
 *   leafDirective      → directive-leaf（块级）
 *   textDirective      → directive-text（行内）
 *
 * 属性命名注意（与 rehype-sanitize 的清洗规则相关）：
 * - 指令名放在 `directive` 属性而不是 `name`（name/id 是 sanitize 的
 *   clobber 属性，会被强制加 user-content- 前缀，见 hast-util-sanitize）；
 * - `{.样式类}` 放在 `dclass`（hast 的 class 属性承载在 className，
 *   直接写 class 不会被属性白名单命中）；
 * - `index` 是本插件按文档顺序计算的编号（第 N 题 / 提示 N / 第 N 步），
 *   让需要编号的组件无需跨组件通信即可显示序号。
 */
const HOST_TAG_BY_TYPE: Readonly<Record<DirectiveNodeType, string>> = {
  containerDirective: "directive-container",
  leafDirective: "directive-leaf",
  textDirective: "directive-text",
};

/** 顺路维护的编号计数器（进入子树时按指令语义更新） */
interface DirectiveCounters {
  /** 题目计数（question 用） */
  question: number;
  /** 当前题目内的提示计数（hint 用；进入新题清零，讲义内 hint 不编号） */
  hint: number;
  /** 当前 steps 内的步骤计数（step 用；进入 steps 清零） */
  step: number;
  /**
   * 当前题目内的填空计数（blank 用；进入新题清零）。编号不依赖 question 上下文
   * （答题页渲染的是独立题干，无 ::::question 包裹）——展示组件忽略该编号，
   * 渲染结果不变（samples 回归不受影响，AGENTS 第 12 条）；T2.6 起答题页按此
   * 编号把空框渲染为可输入控件（BlankAnswersContext）。
   */
  blank: number;
}

function annotate(
  node: DirectiveNode,
  counters: DirectiveCounters,
): DirectiveCounters {
  const next: DirectiveCounters = { ...counters };
  const props: Record<string, string | number> = { directive: node.name };

  if (node.name === "question") {
    next.question += 1;
    next.hint = 0;
    next.blank = 0;
    props.index = next.question;
  } else if (node.name === "hint") {
    if (counters.question > 0) {
      next.hint += 1;
      props.index = next.hint;
    }
  } else if (node.name === "blank") {
    next.blank += 1;
    props.index = next.blank;
  } else if (node.name === "steps") {
    next.step = 0;
  } else if (node.name === "step") {
    next.step += 1;
    props.index = next.step;
  }

  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (key === "class" || key === "id") continue; // class 走 dclass；id 被 sanitize 视为 clobber 属性，不透传
    if (typeof value === "string") props[key] = value;
  }
  const klass = node.attributes?.class;
  if (typeof klass === "string" && klass.length > 0) props.dclass = klass;

  node.data = {
    ...(node.data ?? {}),
    hName: HOST_TAG_BY_TYPE[node.type],
    hProperties: props,
  };
  return next;
}

function walk(node: MdNode, initialCounters: DirectiveCounters): void {
  const children = node.children;
  if (!children) return;
  // 计数器要跨兄弟节点传递：第 1 个 step 计数后，第 2 个 step 要在 1 的基础上继续
  let counters = initialCounters;
  for (const child of children) {
    if (isDirectiveNode(child)) {
      counters = annotate(child, counters);
      walk(child, counters);
    } else {
      walk(child, counters);
    }
  }
}

/** remark 插件入口：无选项，遍历一次完成映射与编号 */
export function remarkDirectiveHost() {
  return (tree: MdNode) => {
    walk(tree, { question: 0, hint: 0, step: 0, blank: 0 });
  };
}
