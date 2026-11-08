import type { LintIssue } from "@tutor/contract";
import { CircleAlert, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildFixPrompt } from "./error-prompt";

/**
 * lint 问题面板 + "复制错误给 AI"（T1.11；T2A.3 按 D21 重写复制格式）：
 * - 展示问题列表（行号/[code]/中文消息/建议），error 红 warning 黄；
 * - 复制：buildFixPrompt（路径 + 错误列表 + ±3 行片段，不附全文）写入剪贴板，
 *   成功显示轻提示；
 * - 剪贴板不可用（非安全上下文/被浏览器拒绝）时降级为弹层展示，可全选手动复制。
 */

export interface ErrorPanelProps {
  /** 文件相对路径（进入提示词，D21）；空字符串 = 粘贴内容（无文件路径） */
  path: string;
  /** 编辑器当前原文（提示词片段来源） */
  markdown: string;
  /** 问题列表（preview issues 或 commit 422 的 _issues） */
  issues: readonly LintIssue[];
}

/** 轻提示自动消失时长 */
const COPIED_HINT_MS = 3000;

export function ErrorPanel({ path, markdown, issues }: ErrorPanelProps) {
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.length - errorCount;

  const [copied, setCopied] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  const prompt = buildFixPrompt([{ path, markdown, issues }]);

  // 复制成功的轻提示自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_HINT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      // 剪贴板不可用（http 非安全上下文 / 浏览器拒绝授权）：降级为弹层手动复制
      setFallbackOpen(true);
    }
  }, [prompt]);

  function handleSelectAll(): void {
    fallbackTextareaRef.current?.focus();
    fallbackTextareaRef.current?.select();
  }

  return (
    <section
      aria-labelledby="lint-issues-heading"
      className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="lint-issues-heading"
          className="flex items-center gap-2 text-sm font-semibold text-destructive"
        >
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          发现 {issues.length} 个问题（{errorCount} 错误 / {warningCount} 警告）
          {errorCount > 0 ? "：修正后才能导入" : "：不影响导入，建议顺手修复"}
        </h2>
        <Button
          ref={copyButtonRef}
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          onClick={() => void handleCopy()}
        >
          <Copy aria-hidden />
          复制错误给 AI
        </Button>
      </div>

      {copied ? (
        <p
          role="status"
          className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          已复制提示词，粘贴给任意 AI 助手即可让它修正文档。
        </p>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {issues.map((issue) => (
          <li
            key={`${issue.code}-${issue.line}-${issue.column}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
          >
            <span
              className={
                issue.level === "error"
                  ? "font-medium text-destructive"
                  : "font-medium text-amber-600 dark:text-amber-400"
              }
            >
              第 {issue.line} 行
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {issue.code}
            </span>
            <span>{issue.message}</span>
            {issue.fix !== undefined ? (
              <span className="text-xs text-muted-foreground">
                建议：{issue.fix}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <Dialog open={fallbackOpen} onOpenChange={setFallbackOpen}>
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-2xl gap-3 p-4"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            handleSelectAll();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            copyButtonRef.current?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogTitle className="min-h-8 content-center pr-12 text-sm leading-snug">
            剪贴板不可用，请手动复制
          </DialogTitle>
          <DialogDescription className="text-xs">
            当前环境不允许直接写剪贴板。全选下方提示词后按 Ctrl+C 复制，粘贴给
            AI 即可。
          </DialogDescription>
          <textarea
            ref={fallbackTextareaRef}
            readOnly
            value={prompt}
            aria-label="提示词全文"
            className="min-h-48 w-full resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              onClick={handleSelectAll}
            >
              全选
            </Button>
            <DialogClose asChild>
              <Button type="button" className="min-h-11 px-4">
                关闭
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
