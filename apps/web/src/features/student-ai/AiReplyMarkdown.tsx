import "katex/dist/katex.min.css";

import { cn } from "cn";
import { memo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { rehypeMathFallback } from "@/features/markdown/rehype-math-fallback";
import {
  aiReplySanitizeSchema,
  inspectAiReplySafety,
  stripReplyImages,
} from "./ai-reply-security";

/**
 * SAI-21 AI 回复专用受限渲染（B11 实施步骤 5）：
 * 复用既有 Markdown/KaTeX 管线与排版（.rich-markdown 样式、KaTeX 放行
 * 白名单单源派生），但与题面渲染（RichMarkdown）有三处收紧——
 * 1. 不加载指令插件：:::steps/::graph/[[…]] 等一律按普通文本呈现，
 *    交互 directive 不执行（无指令宿主标签可挂载）；
 * 2. 图片零加载：源文本先把 Markdown 图片替换为占位说明，清洗 schema
 *    再剥 img 标签（自动远程图片不发出任何网络请求）；
 * 3. 链接协议仅 http/https/mailto：javascript:/data: 在清洗层即丢弃，
 *    保留的外链统一 rel="noopener noreferrer"。
 * 渲染前经 inspectAiReplySafety 入检：字节/公式/节点超限整体替换为
 * 可解释失败说明，不进解析管线（不阻塞题面与页面）。
 */

const aiReplyComponents: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        className="text-primary underline underline-offset-2"
      >
        {children}
      </a>
    ) : (
      // 协议被清洗层丢弃的链接：保留文字、不可点击
      <span className="text-muted-foreground">{children}</span>
    ),
};

export interface AiReplyMarkdownProps {
  /** AI 回复 Markdown 原文（服务端已按 AI_REPLY_MAX_CHARS 封顶） */
  source: string;
  /** 追加到根容器的样式类 */
  className?: string;
}

export const AiReplyMarkdown = memo(function AiReplyMarkdown({
  source,
  className,
}: AiReplyMarkdownProps) {
  const safety = inspectAiReplySafety(source);
  if (!safety.ok) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground"
      >
        {safety.message}
      </p>
    );
  }
  return (
    <div
      className={cn("rich-markdown text-sm", "ai-reply-markdown", className)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[
          rehypeMathFallback,
          rehypeKatex,
          [rehypeSanitize, aiReplySanitizeSchema],
        ]}
        components={aiReplyComponents}
      >
        {stripReplyImages(source)}
      </ReactMarkdown>
    </div>
  );
});
