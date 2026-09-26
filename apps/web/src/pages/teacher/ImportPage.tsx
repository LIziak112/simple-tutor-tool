import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ImportPreviewData, LintIssue } from "@tutor/contract";
import { v1ToV2 } from "@tutor/md-dsl";
import { ArrowLeft, CircleAlert, FileUp, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiPromptPanel } from "@/features/content/AiPromptPanel";
import { parseApiIssues } from "@/features/content/api-issues";
import { contentTreeKey } from "@/features/content/content-queries";
import { ErrorPanel } from "@/features/content/ErrorPanel";
import { lintIssuesToDiagnostics } from "@/features/content/lint-diagnostics";
import { QUESTION_TYPE_LABELS } from "@/features/content/question-meta";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { ApiError, commitImport, previewImport } from "@/lib/api";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * /t/import 导入页（T1.11）：
 * ① 输入区：粘贴 textarea 或选择 .md 文件（FileReader 读文本，文件名填入）；
 * ② 预览：左 CodeMirror（Markdown 高亮 + lint 标注：error 红 / warning 黄下划线，
 *    hover 显示中文消息与修正建议），右 RichMarkdown 渲染（v1 文档先 v1ToV2 转换）；
 *    顶部统计条：版本徽章、单元数/讲义数/题数/题型分布；
 * ③ 编辑即校验：预览态下改动 400ms debounce 重新调 preview，标注随 issues 更新；
 * ④ 有 error 时"确认导入"禁用并显示错误面板（含"复制错误给 AI"）；
 *    commit 422 的 _issues 也进同一面板；成功跳 /t/content（带成功提示）。
 */

/** 编辑后自动重新预览的防抖时长 */
const REPREVIEW_DEBOUNCE_MS = 400;

/** 文件名缺省值（契约要求非空；用户可改） */
const DEFAULT_FILENAME = "未命名.md";

export function ImportPage() {
  const [stage, setStage] = useState<"input" | "preview">("input");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState(DEFAULT_FILENAME);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** commit 422 附带的 issue 列表（非空时覆盖 preview.issues 展示） */
  const [commitIssues, setCommitIssues] = useState<LintIssue[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  /** 调 preview 接口（带序号防抖竞态：过期响应直接丢弃） */
  const runPreview = useCallback(async (md: string, name: string) => {
    if (md.trim().length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    seqRef.current += 1;
    const seq = seqRef.current;
    setPreviewPending(true);
    try {
      const data = await previewImport({ markdown: md, filename: name });
      if (seq !== seqRef.current) return;
      setPreview(data);
      setPreviewError(null);
      setCommitIssues(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setPreview(null);
      setPreviewError(
        err instanceof Error ? err.message : "预览失败，请稍后重试",
      );
    } finally {
      if (seq === seqRef.current) setPreviewPending(false);
    }
  }, []);

  // 预览态下编辑/改文件名 → 400ms debounce 重新预览（输入即校验）
  useEffect(() => {
    if (stage !== "preview") return;
    const timer = setTimeout(() => {
      void runPreview(text, filename);
    }, REPREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [stage, text, filename, runPreview]);

  function handlePreviewClick(): void {
    setStage("preview");
    void runPreview(text, filename);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setFilename(file.name);
    };
    reader.readAsText(file);
    // 允许再次选择同一个文件（change 事件依赖 value 变化）
    event.target.value = "";
  }

  const commitMutation = useMutation({
    mutationFn: commitImport,
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: contentTreeKey });
      navigate("/t/content", {
        state: {
          importSuccess: `导入完成：单元 ${report.units.length} 个（新增 ${report.units.filter((u) => u.inserted).length} / 更新 ${report.units.filter((u) => u.updated).length}），讲义 ${report.lectures.length} 篇，题目新增 ${report.questions.inserted} / 更新 ${report.questions.updated}。`,
        },
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "LINT_ERROR") {
        // 422 的 _issues 并入错误面板（与 preview issues 同一展示）
        setCommitIssues(parseApiIssues(err.extra));
        setCommitError(err.message);
        return;
      }
      setCommitError(
        err instanceof Error ? err.message : "导入失败，请稍后重试",
      );
    },
  });

  const issues = preview?.issues ?? [];
  const hasError = issues.some((i) => i.level === "error");
  const displayedIssues = commitIssues ?? issues;
  const diagnostics = useMemo(
    () => lintIssuesToDiagnostics(displayedIssues, text),
    [displayedIssues, text],
  );
  // v1 文档：issues 行号指向转换后的 v2 文本；渲染预览也按转换后文本
  const renderSource = preview?.version === 1 ? v1ToV2(text) : text;

  const canCommit =
    preview !== null &&
    !hasError &&
    !previewPending &&
    previewError === null &&
    !commitMutation.isPending &&
    text.trim().length > 0;

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-4 md:px-6 md:py-6">
      {/* 面包屑 + 标题 */}
      <nav aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <Link
          to="/t/content"
          className="rounded px-1 py-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          内容
        </Link>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        <span aria-current="page" className="font-medium">
          导入内容
        </span>
      </nav>

      {stage === "input" ? (
        <div className="mt-4 max-w-3xl">
          <h1 className="text-lg font-semibold">导入内容</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            粘贴或选择 Markdown 文档（支持 v2 DSL 与旧版 v1
            格式），预览无误后确认导入。
          </p>

          {/* AI 出题助手（T1.13）：复制「规范+样例+模板」提示词给 AI，产出可导入文档 */}
          <div className="mt-4">
            <AiPromptPanel />
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-56 flex-1 flex-col gap-1.5">
                <label
                  htmlFor="import-filename"
                  className="text-sm font-medium"
                >
                  文件名
                </label>
                <Input
                  id="import-filename"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="练习四.md"
                  className="min-h-11"
                />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                onChange={handleFileChange}
                className="hidden"
                tabIndex={-1}
                aria-hidden
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp aria-hidden />
                选择 .md 文件
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-markdown" className="text-sm font-medium">
                文档内容
              </label>
              <textarea
                id="import-markdown"
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                placeholder={
                  "在此粘贴 Markdown 原文…\n\nv2 文档以 frontmatter 开头：\n---\nkind: practice\nunit: 练习四\n---"
                }
                className="min-h-72 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-[13px] leading-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                文件内容会填入上方输入框，可先编辑再预览。
              </p>
              <Button
                type="button"
                className="min-h-11 px-5"
                disabled={
                  text.trim().length === 0 || filename.trim().length === 0
                }
                onClick={handlePreviewClick}
              >
                <Upload aria-hidden />
                预览
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          {/* 统计条 */}
          <StatsBar
            preview={preview}
            pending={previewPending}
            error={previewError}
            onRetry={() => void runPreview(text, filename)}
          />

          {previewError !== null && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {previewError}
            </p>
          )}

          {/* 左编辑器 / 右渲染预览 */}
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="flex h-[65vh] flex-col overflow-hidden rounded-xl border border-border bg-card">
              <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                原文（带 lint 标注，编辑后自动重新校验）
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <MarkdownEditor
                  value={text}
                  onChange={setText}
                  diagnostics={diagnostics}
                />
              </div>
            </div>
            <div className="flex h-[65vh] flex-col overflow-hidden rounded-xl border border-border bg-card">
              <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                渲染预览
                {preview?.version === 1 && "（v1 文档已自动转换为 v2 后渲染）"}
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto max-w-3xl">
                  <RichMarkdown source={renderSource} />
                </div>
              </div>
            </div>
          </div>

          {/* lint 问题面板 + 复制错误给 AI（§5.1 制作端闭环） */}
          {displayedIssues.length > 0 ? (
            <ErrorPanel
              filename={filename}
              markdown={text}
              issues={displayedIssues}
              version={preview?.version ?? 2}
            />
          ) : null}

          {/* 提交区 */}
          <div className="mt-4 flex flex-wrap items-center gap-3 pb-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              onClick={() => {
                setStage("input");
                setCommitIssues(null);
                setCommitError(null);
              }}
            >
              <ArrowLeft aria-hidden />
              返回重新粘贴
            </Button>
            <Button
              type="button"
              className="min-h-11 px-6"
              disabled={!canCommit}
              onClick={() => {
                setCommitError(null);
                commitMutation.mutate({ markdown: text, filename });
              }}
            >
              {commitMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在导入…
                </>
              ) : (
                "确认导入"
              )}
            </Button>
            {hasError ? (
              <p className="text-sm text-destructive" role="alert">
                文档存在错误级问题，请先修正（或复制错误给 AI 帮忙修）。
              </p>
            ) : null}
            {commitError !== null && !hasError ? (
              <p className="text-sm text-destructive" role="alert">
                {commitError}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/** 顶部统计条：版本徽章 + 单元/讲义/题数 + 题型分布 */
function StatsBar({
  preview,
  pending,
  error,
  onRetry,
}: {
  preview: ImportPreviewData | null;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      >
        <p className="text-sm text-destructive">预览失败：{error}</p>
        <Button variant="outline" className="min-h-11 px-4" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  const summary = preview?.summary;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      {preview !== null ? (
        <span
          className={
            preview.version === 2
              ? "rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300"
              : "rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300"
          }
          title={
            preview.version === 2
              ? "DSL v2 文档"
              : "旧版 v1 文档（导入时自动转换为 v2）"
          }
        >
          DSL v{preview.version}
        </span>
      ) : null}
      {summary !== undefined ? (
        <>
          <span>
            单元 <strong>{summary.unitCount}</strong>
          </span>
          <span>
            讲义 <strong>{summary.lectureCount}</strong>
          </span>
          <span>
            题目 <strong>{summary.questionCount}</strong>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {Object.entries(summary.typeDistribution).map(([type, count]) => (
              <span
                key={type}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {QUESTION_TYPE_LABELS[
                  type as keyof typeof QUESTION_TYPE_LABELS
                ] ?? type}{" "}
                {count}
              </span>
            ))}
          </span>
        </>
      ) : (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在分析文档…
        </span>
      )}
      {pending && summary !== undefined ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          重新校验中…
        </span>
      ) : null}
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default ImportPage;
