import { createQuestionBlockKeyer } from "@tutor/md-dsl";

/**
 * 给题面块级元素打语义节点键（LR-5，学习记录模型设计稿 §5.1/§5.2）。
 * 两个通道，同一枚举器（@tutor/md-dsl createQuestionBlockKeyer——与
 * questionNodesOf 同一套分类/计数/键生成），键序列跨「枚举 / 渲染」一致
 * （parity 单测锁定）：
 *
 * - `remarkLrNodes`：remark 阶段走根级子节点，键经 node.data.hProperties 进
 *   hast（sanitize schema 放行 data-lr-node）——覆盖 p/标题/列表项/表格/
 *   代码/引用等标准元素；
 * - `rehypeLrNodesFill`：rehype 末端（sanitize 之后）在 hast 根级**重放**
 *   同一枚举（标签→词表适配），给缺失键的块补键——公式块（remark-rehype
 *   的 math 处理不保留 hProperties，KaTeX 原地替换后键会丢）在这里补齐。
 *   重放对已键元素是幂等校验（同输入恒同键）。
 *
 * 只在普通形态管线挂载；compact 单行收敛形态（错题本行内预览）不需要
 * 锚点键，不挂。measureQuestionSurface 据此采集 blocks[].node（子块
 * .katex/th/td 落最近的带键祖先，含自身）。
 */

/** hast 元素的结构化视图（避免直接依赖 @types/hast 的类型面） */
interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown> | undefined;
  children: unknown[];
}

/** hast 根级子节点的宽松视图 */
interface HastChild {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown> | undefined;
  children?: unknown[];
}

/** 显示公式包装判定：KaTeX 把 math 节点原地替换为 .katex-display 包装 */
function isMathBlock(node: HastChild): boolean {
  const className = node.properties?.className;
  const classes = Array.isArray(className)
    ? className.join(" ")
    : typeof className === "string"
      ? className
      : "";
  return classes.includes("katex-display") || classes.includes("math-display");
}

/** hast 标签 → mdast 词表适配（喂给同一枚举器；其余一律 other 保计数对齐） */
function hastBlockType(node: HastChild): string {
  switch (node.tagName) {
    case "p":
      return "paragraph";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listItem";
    case "table":
      return "table";
    case "pre":
      return "code";
    default:
      return isMathBlock(node) ? "math" : "other";
  }
}

/** remark 阶段输入树的宽松视图（web 侧不依赖 @types/unist） */
interface MdastLike {
  type: string;
  children?: MdastLike[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

/** remark 阶段：标准元素的键经 hProperties 进 hast（code 除外——remark-rehype
 * 的代码处理器把 hProperties 同时落在 pre 与 code 上产生重复键，code 块由
 * rehypeLrNodesFill 在 pre 一处补键） */
export function remarkLrNodes(): (tree: MdastLike) => void {
  return (tree) => {
    const keyer = createQuestionBlockKeyer();
    const children = tree.children ?? [];
    for (const child of children) {
      // 与 questionNodesOf 同口径：list 是包装节点，listItem 自成块级节点
      const blocks = child.type === "list" ? (child.children ?? []) : [child];
      for (const block of blocks) {
        const entry = keyer(block as Parameters<typeof keyer>[0]);
        if (block.type === "code") continue; // 留给 rehype 末端填充
        block.data = {
          ...block.data,
          hProperties: {
            ...block.data?.hProperties,
            "data-lr-node": entry.key,
          },
        };
      }
    }
  };
}

/** rehype 末端填充：重放枚举，给缺失键的块（公式包装等）补 data-lr-node */
export function rehypeLrNodesFill(): (tree: unknown) => void {
  return (tree) => {
    const children = (tree as { children?: HastChild[] }).children ?? [];
    const keyer = createQuestionBlockKeyer();
    const stamp = (node: unknown, key: string): void => {
      const el = node as HastElement | undefined;
      if (el === undefined || el === null || el.type !== "element") return;
      const properties = { ...(el.properties ?? {}) };
      if (properties["data-lr-node"] === undefined) {
        properties["data-lr-node"] = key;
        el.properties = properties;
      }
    };
    for (const child of children) {
      const type = hastBlockType(child);
      if (type === "list") {
        // list 包装自身不打键；每个 listItem 自成块级节点（与枚举同口径）
        for (const item of child.children ?? []) {
          stamp(item, keyer({ type: "listItem" }).key);
        }
        continue;
      }
      stamp(child, keyer({ type }).key);
    }
  };
}
