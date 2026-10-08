import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkBlank } from "./remark/remark-blank";
import { remarkDirectiveHost } from "./remark/remark-directive-host";
import { richMarkdownSanitizeSchema } from "./sanitize";

/**
 * RichMarkdown 管线的插件配置清单（单一来源）：
 * 与 packages/md-dsl 解析器同一套 remark 插件，保证解析口径一致——
 *   remarkParse → remark-frontmatter → remark-math → remark-gfm → remark-directive
 *   → remarkBlank（[[…]] → blank 指令）→ remarkDirectiveHost（指令 → 宿主标签）
 *   → rehype-katex（公式）→ rehype-sanitize（自定义 schema：放行 KaTeX 输出与
 *     指令宿主标签，清除 script/事件属性/javascript: 协议）
 *
 * 消费方：主应用 RichMarkdown 与静态导出管线（合成图 export-review-image，
 * 宿主组件换静态版但解析口径必须与主应用一致）——主站 Markdown 增强时
 * 管线定义不会隐式分叉（审查修复轮：此前两处重复手写同一清单）。
 */

/** 从 ReactMarkdown 的 props 取插件表类型（PluggableList），避免直接依赖 unified 类型包 */
type ReactMarkdownProps = ComponentProps<typeof ReactMarkdown>;
export type RemarkPluginList = NonNullable<ReactMarkdownProps["remarkPlugins"]>;
export type RehypePluginList = NonNullable<ReactMarkdownProps["rehypePlugins"]>;

export const richMarkdownRemarkPlugins: RemarkPluginList = [
  [remarkFrontmatter, ["yaml"]],
  remarkMath,
  remarkGfm,
  remarkDirective,
  remarkBlank,
  remarkDirectiveHost,
];

export const richMarkdownRehypePlugins: RehypePluginList = [
  rehypeKatex,
  // rehype-sanitize 的选项就是 schema 本身（v6 签名：rehypeSanitize(schema)）
  [rehypeSanitize, richMarkdownSanitizeSchema],
];
