import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AI_PROMPT_KIND_OPTIONS,
  type AiPromptKind,
  buildAiPrompt,
} from "./ai-prompt";
import { useSpecDocs } from "./spec-queries";

/**
 * "AI 出题助手"面板（T1.13，§5.1 规范文档化）：导入页顶部的可折叠卡片。
 * - 选择内容类型（练习/讲义/混合）+ 可选主题/考点；
 * - "一键复制给 AI"：把「规范 + 完整样例 + 提示词模板」按开头/结尾要求拼成完整
 *   提示词（拼装见 ai-prompt.ts）写入剪贴板，粘贴给任意大模型即可产出可直接
 *   导入的 DSL 文档；
 * - 三份文档经 /api/public/spec 拉取（TanStack Query 缓存，展开时才加载）；
 * - 三态齐全：加载中（按钮 spinner）/ 错误（原因 + 重试）/ 成功（轻提示）；
 * - 剪贴板不可用（http 非安全上下文等）时降级为内嵌文本框手动复制。
 */

/** 复制成功的轻提示自动消失时长 */
const COPIED_HINT_MS = 3000;

export function AiPromptPanel() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AiPromptKind>("practice");
  const [topic, setTopic] = useState("");
  const [copied, setCopied] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  // 展开时才拉取规范文档（收起不发请求，按需加载）
  const spec = useSpecDocs(open);

  const prompt =
    spec.data !== undefined
      ? buildAiPrompt({
          kind,
          topic,
          rules: spec.data.rules,
          example: spec.data.example,
          promptTemplate: spec.data.prompt,
        })
      : "";

  // 复制成功的轻提示自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_HINT_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (prompt === "") return;
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      // 剪贴板不可用（http 非安全上下文 / 浏览器拒绝授权）：降级为手动复制
      setFallbackOpen(true);
    }
  }, [prompt]);

  function handleSelectAll(): void {
    fallbackTextareaRef.current?.focus();
    fallbackTextareaRef.current?.select();
  }

  return (
    <section
      aria-labelledby="ai-prompt-heading"
      className="rounded-xl border border-sky-500/30 bg-sky-500/5"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="ai-prompt-body"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-left outline-none transition-colors hover:bg-sky-500/10 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          id="ai-prompt-heading"
          className="flex items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300"
        >
          <Sparkles aria-hidden className="size-4 shrink-0" />
          AI 出题助手
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {open ? "收起" : "让 AI 按本系统 DSL 生成内容，展开使用"}
          {open ? (
            <ChevronUp aria-hidden className="size-4" />
          ) : (
            <ChevronDown aria-hidden className="size-4" />
          )}
        </span>
      </button>

      {open ? (
        <div id="ai-prompt-body" className="border-t border-sky-500/30 p-4">
          <p className="text-sm text-muted-foreground">
            选择内容类型、填写主题，一键复制完整提示词（含 DSL
            规范、完整样例与出题模板），粘贴给任意 AI；把 AI 输出的 markdown
            粘贴到下方导入即可。
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">内容类型</legend>
              <div className="flex flex-wrap gap-2">
                {AI_PROMPT_KIND_OPTIONS.map((option) => {
                  const active = kind === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setKind(option.value)}
                      className={
                        active
                          ? "min-h-11 rounded-full border border-sky-500 bg-sky-500 px-4 text-sm font-medium text-white outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50"
                          : "min-h-11 rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex min-w-56 flex-1 flex-col gap-1.5">
              <label htmlFor="ai-prompt-topic" className="text-sm font-medium">
                主题 / 考点（可选）
              </label>
              <Input
                id="ai-prompt-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如：一元一次方程"
                className="min-h-11"
              />
            </div>
          </div>

          {spec.isError ? (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <span className="flex items-start gap-2">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                规范文档加载失败：
                {spec.error instanceof Error
                  ? spec.error.message
                  : "请稍后重试"}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => void spec.refetch()}
              >
                重试
              </Button>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              ref={copyButtonRef}
              type="button"
              className="min-h-11 px-5"
              disabled={spec.isPending || spec.data === undefined}
              onClick={() => void handleCopy()}
            >
              {spec.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在加载规范…
                </>
              ) : (
                <>
                  <Copy aria-hidden />
                  一键复制给 AI
                </>
              )}
            </Button>
            {copied ? (
              <p
                role="status"
                className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300"
              >
                已复制，粘贴给你的 AI 即可。
              </p>
            ) : null}
          </div>

          {fallbackOpen ? (
            <div className="mt-3 rounded-lg border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">
                当前环境不允许直接写剪贴板。全选下方提示词后按 Ctrl+C
                复制，粘贴给 AI 即可。
              </p>
              <textarea
                ref={fallbackTextareaRef}
                readOnly
                value={prompt}
                aria-label="提示词全文"
                className="mt-2 min-h-48 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 outline-none"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  onClick={handleSelectAll}
                >
                  全选
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
