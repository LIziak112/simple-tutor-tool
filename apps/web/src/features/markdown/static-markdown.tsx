import { createElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  richMarkdownRehypePlugins,
  richMarkdownRemarkPlugins,
} from "@/features/markdown/pipeline";

/**
 * 静态 markdown 渲染（T6R.19 合成图 / T6R.20 标注底图共用；审查修复 6 抽出）：
 * 与 RichMarkdown 同一套 remark/rehype 管线（插件清单单一来源 pipeline.ts），
 * 宿主组件换静态版——指令容器永远展开、行内 blank/mark 静态化，其余交互指令
 * 以文字说明降级。两条管线的**唯一差异点**是 ::image 叶子（底图渲染真实
 * 图片、复习合成图指引附件区），经 renderImage 注入。
 */

/** react-markdown 注入的 hast 元素（本层只读 properties） */
interface HastNodeLike {
  readonly properties?: Record<string, unknown>;
}

function directiveNameOf(node: unknown): string {
  const directive = (node as HastNodeLike | null)?.properties?.directive;
  return typeof directive === "string" ? directive : "";
}

function attrOf(node: unknown, key: string): string | undefined {
  const value = (node as HastNodeLike | null)?.properties?.[key];
  return typeof value === "string" ? value : undefined;
}

/** ::image 指令的静态渲染入参（src 已在管线侧归一化） */
export interface StaticImageAttrs {
  readonly src: string | undefined;
  readonly alt: string | undefined;
}

/** 块级容器静态标签（折叠块/分步等永远展开；材料已含静态说明行） */
const STATIC_CONTAINER_LABELS: Record<string, string> = {
  question: "题目",
  hint: "提示",
  answer: "答案",
  solution: "解答",
  example: "例",
  steps: "分步",
  step: "步骤",
  fold: "折叠块",
  tip: "提示",
  warning: "注意",
  box: "框注",
  columns: "分栏",
  col: "栏",
};

function StaticDirectiveContainer({
  node,
  children,
}: {
  node?: unknown;
  children?: ReactNode;
}): ReactElement {
  const label = STATIC_CONTAINER_LABELS[directiveNameOf(node)];
  return createElement(
    "div",
    {
      style: {
        margin: "10px 0",
        padding: "10px 14px",
        borderLeft: "3px solid #94a3b8",
        background: "#f1f5f9",
        borderRadius: "4px",
      },
    },
    label !== undefined
      ? createElement(
          "div",
          {
            style: { fontSize: "12px", color: "#475569", marginBottom: "6px" },
          },
          `【${label}】`,
        )
      : null,
    children,
  );
}

function StaticDirectiveLeaf({
  node,
  renderImage,
}: {
  node?: unknown;
  renderImage: ((attrs: StaticImageAttrs) => ReactElement) | undefined;
}): ReactElement {
  const name = directiveNameOf(node);
  if (name === "image") {
    // renderImage 缺省=「配图见附件区」文字降级（T6R.19 复习合成图口径）
    const fallback = (): ReactElement =>
      createElement(
        "p",
        { style: { margin: "8px 0", fontSize: "13px", color: "#475569" } },
        "【配图】见下方图片附件区块",
      );
    return (renderImage ?? fallback)({
      src: attrOf(node, "src")?.trim(),
      alt: attrOf(node, "alt")?.trim(),
    });
  }
  return createElement(
    "p",
    { style: { margin: "8px 0", fontSize: "13px", color: "#475569" } },
    `【${name.length > 0 ? name : "指令"}】交互内容以静态材料说明为准`,
  );
}

/** 静态行内指令宿主：blank=下划线空框；mark=高亮；其余按原文呈现 */
function StaticDirectiveText({
  node,
  children,
}: {
  node?: unknown;
  children?: ReactNode;
}): ReactElement {
  const name = directiveNameOf(node);
  if (name === "blank") {
    return createElement("span", {
      style: {
        display: "inline-block",
        minWidth: "3em",
        borderBottom: "1.5px solid #64748b",
        height: "1em",
      },
    });
  }
  if (name === "mark") {
    return createElement(
      "span",
      {
        style: { background: "#fef08a", padding: "0 2px", borderRadius: "2px" },
      },
      children,
    );
  }
  return createElement("span", null, children);
}

/**
 * 单段 markdown 的静态渲染（.rich-markdown 全局排版样式与主应用一致）。
 * @param renderImage ::image 叶子渲染器（两条管线的差异点）；缺省按
 *   「配图见下方图片附件区块」文字降级（T6R.19 复习合成图口径）。
 */
export function StaticMarkdown({
  md,
  renderImage,
}: {
  md: string;
  renderImage?: (attrs: StaticImageAttrs) => ReactElement;
}): ReactElement {
  const staticComponents = {
    "directive-container": StaticDirectiveContainer,
    "directive-leaf": (props: { node?: unknown }): ReactElement =>
      StaticDirectiveLeaf({ ...props, renderImage }),
    "directive-text": StaticDirectiveText,
  } as unknown as Parameters<typeof ReactMarkdown>[0]["components"];
  return createElement(
    "div",
    { className: "rich-markdown" },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: richMarkdownRemarkPlugins,
        rehypePlugins: richMarkdownRehypePlugins,
        components: staticComponents,
      },
      md,
    ),
  );
}
