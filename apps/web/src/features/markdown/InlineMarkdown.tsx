import "katex/dist/katex.min.css";

import { getDirective } from "@tutor/contract";
import { cn } from "cn";
import { type ComponentProps, memo, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { DirectiveTextHost } from "./directives";
import { DirectiveSessionProvider } from "./directives/session-context";
import {
  richMarkdownRehypePlugins,
  richMarkdownRemarkPlugins,
} from "./pipeline";

/**
 * <InlineMarkdown source>：Markdown/DSL 的单行收敛形态（2026-10，错题本紧凑行）。
 *
 * 与 RichMarkdown 走同一条解析管线（pipeline.ts 单一来源：remark-math / gfm /
 * directive / blank / 宿主 → katex → sanitize），只换渲染层，专供「一行放下
 * 一道题干」的列表预览：
 * - 根元素与全部块级元素（段落、标题、列表、引用、代码块）都是 <span>——
 *   可放进 <button> 等只接受短语内容的父元素，截断交给外层容器的 truncate
 *   / line-clamp；块与块之间由 hast 保留的换行文本节点自然隔开；
 * - 公式照常 KaTeX；块级公式随行内排、不独占一行（index.css 的
 *   .rich-markdown-inline 覆盖 katex-display 的块级排版）；
 * - 图片（![…](…) 与 ::image）、表格、函数图像降级为「[图]」「[表格]」
 *   「[函数图像]」占位——预览行放不下媒体，完整内容看展开卡；
 * - 行内指令照常（[[…]] 填空空框、:mark 荧光笔）；容器/块指令只保留正文；
 *   填空恒为展示空框（本层显式切断外层作答态，预览永不渲染输入框）；
 * - 链接降为纯文本、任务列表复选框不渲染（按钮内不得嵌套交互元素）。
 *
 * 不提供指令遥测与题块占位（预览行没有这些交互）。相同属性不重复解析
 * （React 默认属性比较，与 RichMarkdown 同一约定）。
 */

export interface InlineMarkdownProps {
  /** Markdown 原文（学生端题干须已经 displayStemMd / studentStemMd 投影） */
  source: string;
  /** 追加到根 <span> 的样式类 */
  className?: string;
}

/** 占位胶囊（图 / 表格 / 函数图像）：弱化色，不抢正文 */
const PLACEHOLDER_CLASS =
  "mx-0.5 rounded bg-muted px-1 text-[0.85em] text-muted-foreground";

/** 媒体占位：图片带 alt 时把 alt 交给无障碍名（可见文案仍是「[图]」） */
function MediaPlaceholder({
  label,
  alt,
}: {
  label: string;
  alt?: string | undefined;
}) {
  const description = alt?.trim();
  return (
    <span
      role="img"
      aria-label={description ? `${label}：${description}` : label}
      className={PLACEHOLDER_CLASS}
    >
      [{label}]
    </span>
  );
}

/** 宿主组件收到的 hast 节点形态（只读 properties，与 directives/index.tsx 同口径） */
interface HastElementLike {
  properties?: Record<string, unknown>;
}

/** 媒体类块指令 → 占位文案（按注册表主名；别名经 getDirective 归一） */
const DIRECTIVE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  image: "图",
  graph: "函数图像",
};

/**
 * 容器 / 块指令的行内宿主：媒体指令渲染占位，其余只保留正文（不渲染卡片、
 * 折叠、分栏等块级外壳）。未注册指令同样只保留正文——预览行不展示降级提示。
 */
function InlineDirectiveHost({
  node,
  children,
}: {
  node?: HastElementLike | undefined;
  children?: ReactNode;
}) {
  const properties = node?.properties ?? {};
  const raw = properties.directive;
  const name = typeof raw === "string" ? (getDirective(raw)?.name ?? raw) : "";
  if (Object.hasOwn(DIRECTIVE_PLACEHOLDERS, name)) {
    const alt = properties.alt;
    return (
      <MediaPlaceholder
        label={DIRECTIVE_PLACEHOLDERS[name] ?? name}
        alt={typeof alt === "string" ? alt : undefined}
      />
    );
  }
  return <span>{children}</span>;
}

function InlineImage({ alt }: ComponentProps<"img">) {
  return <MediaPlaceholder label="图" alt={alt} />;
}

function InlineTable() {
  return <span className={PLACEHOLDER_CLASS}>[表格]</span>;
}

/** 链接降为纯文本（按钮内不嵌套可点元素；预览不需要跳转） */
function InlineLink({ children }: ComponentProps<"a">) {
  return <span>{children}</span>;
}

/** 强制换行在单行预览里退化为一个空格 */
function InlineBreak() {
  return " ";
}

/** 不渲染任何内容（任务列表复选框、分隔线） */
function Nothing() {
  return null;
}

/**
 * 标签映射：块级一律降为 span；媒体与交互元素换占位或移除。
 * 自定义宿主标签不在 react-markdown Components 的键集合内，以变量合并传入
 * （与 RichMarkdown 同一处理）。
 */
const inlineComponents = {
  p: "span",
  h1: "span",
  h2: "span",
  h3: "span",
  h4: "span",
  h5: "span",
  h6: "span",
  ul: "span",
  ol: "span",
  li: "span",
  blockquote: "span",
  pre: "span",
  section: "span",
  img: InlineImage,
  table: InlineTable,
  a: InlineLink,
  br: InlineBreak,
  hr: Nothing,
  input: Nothing,
  "directive-container": InlineDirectiveHost,
  "directive-leaf": InlineDirectiveHost,
  "directive-text": DirectiveTextHost,
} as unknown as Components;

/** 相同属性不重复解析（React 默认属性比较）。 */
export const InlineMarkdown = memo(function InlineMarkdown({
  source,
  className,
}: InlineMarkdownProps) {
  return (
    <span className={cn("rich-markdown rich-markdown-inline", className)}>
      {/* 预览恒为展示形态：切断外层作答态与遥测，空框不变输入框 */}
      <DirectiveSessionProvider fill={null} telemetry={null}>
        <ReactMarkdown
          remarkPlugins={richMarkdownRemarkPlugins}
          rehypePlugins={richMarkdownRehypePlugins}
          components={inlineComponents}
        >
          {source}
        </ReactMarkdown>
      </DirectiveSessionProvider>
    </span>
  );
});
