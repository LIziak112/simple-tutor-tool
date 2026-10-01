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
import type { DirectiveTelemetryInfo } from "./directives/expand-context";
import { DirectiveTelemetryContext } from "./directives/expand-context";
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
  /**
   * 指令交互遥测回调（T4.0b directive_interact 埋点）：折叠开/合、steps 揭晓
   * 都经 DirectiveTelemetryContext 下发到各指令组件，组件只报
   * {name, index(文档全局序号), action, step?}——归属哪个 scope/宿主由本回调
   * 的提供方（页面层）决定；缺省不收集（教师端预览等场景）。
   */
  onDirectiveTelemetry?:
    | ((event: DirectiveTelemetryInfo) => void)
    | undefined;
  /**
   * 指令展开回调（T2.10 兼容别名，仅 open 方向）：内部映射为
   * onDirectiveTelemetry 的 action=open；与 onDirectiveTelemetry 同时提供时
   * 以后者为准（新回调信息量是旧回调的严格超集）。
   */
  onDirectiveExpand?:
    | ((info: { name: string; index: number }) => void)
    | undefined;
}

export function RichMarkdown({
  source,
  className,
  onDirectiveTelemetry,
  onDirectiveExpand,
}: RichMarkdownProps) {
  // 兼容别名：旧回调只收 open 方向（收起/揭晓是 T4.0b 新增语义，旧回调不感知）
  const telemetry: ((event: DirectiveTelemetryInfo) => void) | null =
    onDirectiveTelemetry ??
    (onDirectiveExpand !== undefined
      ? (event) => {
          if (event.action === "open") {
            onDirectiveExpand({ name: event.name, index: event.index });
          }
        }
      : null);
  return (
    <div className={cn("rich-markdown", className)}>
      <DirectiveTelemetryContext.Provider value={telemetry}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={directiveHostComponents}
        >
          {source}
        </ReactMarkdown>
      </DirectiveTelemetryContext.Provider>
    </div>
  );
}
