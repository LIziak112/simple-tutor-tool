import type { LintIssue } from "@tutor/contract";
import { CircleAlert, Copy, Info, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildLintErrorPrompt } from "./error-prompt";

/**
 * lint 问题面板 + "复制错误给 AI"（T1.11，§5.1 制作端闭环）：
 * - 展示问题列表（行号/[code]/中文消息/建议），error 红 warning 黄；
 * - 复制：把 buildLintErrorPrompt 的提示词写入剪贴板，成功显示轻提示；
 * - 剪贴板不可用（非安全上下文/被浏览器拒绝）时降级为弹层展示，可全选手动复制。
 */

export interface ErrorPanelProps {
  /** 导入时填写的文件名（进入提示词） */
  filename: string;
  /** 编辑器当前原文（进入提示词；v1 文档为原始文本） */
  markdown: string;
  /** 问题列表（preview issues 或 commit 422 的 _issues） */
  issues: readonly LintIssue[];
  /** 文档版本（v1 提示词附加行号说明） */
  version: 1 | 2;
}

/** 轻提示自动消失时长 */
const COPIED_HINT_MS = 3000;

export function ErrorPanel({
  filename,
  markdown,
  issues,
  version,
}: ErrorPanelProps) {
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.length - errorCount;

  const [copied, setCopied] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  const prompt = buildLintErrorPrompt({ filename, markdown, issues, version });

  // 复制成功的轻提示自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_HINT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // 弹层打开时聚焦文本框；Escape 关闭并把焦点还给按钮
  useEffect(() => {
    if (!fallbackOpen) return;
    fallbackTextareaRef.current?.focus();
    fallbackTextareaRef.current?.select();
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setFallbackOpen(false);
        copyButtonRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fallbackOpen]);

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

      {version === 1 ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          v1 文档：问题行号对应自动转换后的 v2 文本，与左侧原文行号可能不一致。
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

      {fallbackOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="copy-fallback-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card p-4 shadow-lg">
            <div className="flex items-center justify-between gap-3">
              <h3 id="copy-fallback-heading" className="text-sm font-semibold">
                剪贴板不可用，请手动复制
              </h3>
              <button
                type="button"
                aria-label="关闭弹层"
                onClick={() => {
                  setFallbackOpen(false);
                  copyButtonRef.current?.focus();
                }}
                className="flex size-8 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              当前环境不允许直接写剪贴板。全选下方提示词后按 Ctrl+C 复制，粘贴给
              AI 即可。
            </p>
            <textarea
              ref={fallbackTextareaRef}
              readOnly
              value={prompt}
              aria-label="提示词全文"
              className="mt-2 min-h-48 w-full flex-1 resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={handleSelectAll}
              >
                全选
              </Button>
              <Button
                type="button"
                className="min-h-11 px-4"
                onClick={() => {
                  setFallbackOpen(false);
                  copyButtonRef.current?.focus();
                }}
              >
                关闭
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
