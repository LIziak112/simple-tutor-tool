import "katex/dist/katex.min.css";

import { cn } from "cn";
import { memo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Button } from "@/components/ui/button";
import { rehypeMathFallback } from "@/features/markdown/rehype-math-fallback";
import { normalizeAiReplyMath, replyTextPage } from "./ai-reply-format";
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
  const [textOpen, setTextOpen] = useState(false);
  const [page, setPage] = useState(0);
  // 先检查原始字节，再规范化并重新核对公式与节点预算。
  const initial = inspectAiReplySafety(source);
  const normalized = initial.ok ? normalizeAiReplyMath(source) : source;
  const safety = initial.ok ? inspectAiReplySafety(normalized) : initial;
  if (!safety.ok) {
    const plain = replyTextPage(source, page);
    return (
      <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <p role="alert">{safety.message}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => setTextOpen(!textOpen)}
        >
          {textOpen ? "收起原文" : "查看安全纯文本"}
        </Button>
        {textOpen && (
          <>
            <p className="text-muted-foreground">
              原文仅按文字展示，不执行公式、图片或链接。
            </p>
            <section
              className="whitespace-pre-wrap break-words font-sans text-base leading-7"
              aria-label="回复纯文本"
            >
              {plain.text}
            </section>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={plain.page === 0}
                onClick={() => setPage(plain.page - 1)}
              >
                上一段
              </Button>
              <span role="status">
                第 {plain.page + 1} / {plain.count} 段
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={plain.page + 1 === plain.count}
                onClick={() => setPage(plain.page + 1)}
              >
                下一段
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rich-markdown text-base leading-7 ai-reply-markdown",
        className,
      )}
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
        {stripReplyImages(normalized)}
      </ReactMarkdown>
    </div>
  );
});
