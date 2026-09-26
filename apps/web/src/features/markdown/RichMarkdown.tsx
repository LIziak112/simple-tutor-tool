import "katex/dist/katex.min.css";

import { cn } from "cn";
import type { ComponentProps } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  DirectiveContainerHost,
  DirectiveLeafHost,
  DirectiveTextHost,
} from "./directives";
import { remarkBlank } from "./remark/remark-blank";
import { remarkDirectiveHost } from "./remark/remark-directive-host";
import { richMarkdownSanitizeSchema } from "./sanitize";

/**
 * <RichMarkdown source>（T1.8）：Markdown/DSL v2 统一渲染入口。
 *
 * 管线（与 packages/md-dsl 解析器同一套 remark 插件，保证解析口径一致）：
 *   remarkParse → remark-frontmatter → remark-math → remark-gfm → remark-directive
 *   → remarkBlank（[[…]] → blank 指令）→ remarkDirectiveHost（指令 → 宿主标签）
 *   → rehype-katex（公式）→ rehype-sanitize（自定义 schema：放行 KaTeX 输出与
 *     指令宿主标签，清除 script/事件属性/javascript: 协议）
 *
 * KaTeX 的 CSS/字体经上方 css 导入随 Vite 本地打包（禁 CDN）。
 * 基础 Markdown 元素排版样式见 src/index.css 的 .rich-markdown 段。
 */

/** 从 ReactMarkdown 的 props 取插件表类型（PluggableList），避免直接依赖 unified 类型包 */
type ReactMarkdownProps = ComponentProps<typeof ReactMarkdown>;
type RemarkPluginList = NonNullable<ReactMarkdownProps["remarkPlugins"]>;
type RehypePluginList = NonNullable<ReactMarkdownProps["rehypePlugins"]>;

const remarkPlugins: RemarkPluginList = [
  [remarkFrontmatter, ["yaml"]],
  remarkMath,
  remarkGfm,
  remarkDirective,
  remarkBlank,
  remarkDirectiveHost,
];

const rehypePlugins: RehypePluginList = [
  rehypeKatex,
  // rehype-sanitize 的选项就是 schema 本身（v6 签名：rehypeSanitize(schema)）
  [rehypeSanitize, richMarkdownSanitizeSchema],
];

// 自定义宿主标签（directive-container 等）不在 react-markdown Components
// 类型（JSX.IntrinsicElements）的键集合内；以变量合并传入，避开对象字面量的
// 多余属性检查。宿主组件内部只读 node.properties，不依赖 DOM 属性透传。
const directiveHostComponents = {
  "directive-container": DirectiveContainerHost,
  "directive-leaf": DirectiveLeafHost,
  "directive-text": DirectiveTextHost,
} as unknown as Components;

export interface RichMarkdownProps {
  /** Markdown 原文（DSL v2：指令 + 数学 + GFM + frontmatter） */
  source: string;
  /** 追加到根容器的样式类 */
  className?: string;
}

export function RichMarkdown({ source, className }: RichMarkdownProps) {
  return (
    <div className={cn("rich-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={directiveHostComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
