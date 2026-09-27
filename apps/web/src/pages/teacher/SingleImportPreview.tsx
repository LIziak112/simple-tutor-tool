import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ImportPreviewData, LintIssue } from "@tutor/contract";
import { v1ToV2 } from "@tutor/md-dsl";
import { ArrowLeft, CircleAlert, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { ActionsPanel } from "@/features/content/ActionsPanel";
import { parseApiIssues } from "@/features/content/api-issues";
import { contentTreeKey } from "@/features/content/content-queries";
import { ErrorPanel } from "@/features/content/ErrorPanel";
import { lintIssuesToDiagnostics } from "@/features/content/lint-diagnostics";
import { QUESTION_TYPE_LABELS } from "@/features/content/question-meta";
import { libraryInvalidations } from "@/features/library/library-queries";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { ApiError, commitImport, previewImport } from "@/lib/api";
import type { ImportOptions } from "./ImportPage";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * 单文件导入预览（T1.11 的预览态；T2A.3 从 ImportPage 拆出并接入资源库选项）：
 * - 左 CodeMirror（Markdown 高亮 + lint 标注），右 RichMarkdown 渲染（v1 先转换）；
 * - 顶部统计条（版本徽章、单元/讲义/题数/题型分布）；
 * - 动作清单与注意事项面板（D18/D19，T2A.3）；
 * - 编辑即校验：预览态下改动 400ms debounce 重新调 preview；
 * - 有 error 时「确认导入」禁用并显示错误面板（「复制错误给 AI」按 D21 新格式）；
 *   commit 422 的 _issues 也进同一面板；成功跳 /t/library（带成功提示）。
 */

/** 编辑后自动重新预览的防抖时长 */
const REPREVIEW_DEBOUNCE_MS = 400;

export interface SingleImportPreviewProps {
  /** 单文件输入（来自粘贴或恰好选择一个文件） */
  readonly input: {
    readonly markdown: string;
    readonly filename: string;
    /** 相对路径；空 = 粘贴内容（无文件路径，D21 提示词口径） */
    readonly path: string;
  };
  readonly options: ImportOptions;
  readonly onBack: () => void;
}

export function SingleImportPreview({
  input,
  options,
  onBack,
}: SingleImportPreviewProps) {
  const [text, setText] = useState(input.markdown);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** commit 422 附带的 issue 列表（非空时覆盖 preview.issues 展示） */
  const [commitIssues, setCommitIssues] = useState<LintIssue[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  // 文件名在输入区确定（input.filename），预览态不可改
  const filename = input.filename;

  const seqRef = useRef(0);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  /** 调 preview 接口（带序号防抖竞态：过期响应直接丢弃）；folderId 只在有值时携带 */
  const runPreview = useCallback(
    async (md: string, name: string) => {
      if (md.trim().length === 0) {
        setPreview(null);
        setPreviewError(null);
        return;
      }
      seqRef.current += 1;
      const seq = seqRef.current;
      setPreviewPending(true);
      try {
        const data = await previewImport({
          markdown: md,
          filename: name,
          ...(options.folderId !== null ? { folderId: options.folderId } : {}),
          ...(input.path.length > 0 ? { sourcePath: input.path } : {}),
        });
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
    },
    [input.path, options.folderId],
  );

  // 初次进入即预览；编辑/改文件名 → 400ms debounce 重新预览（输入即校验）
  useEffect(() => {
    const timer = setTimeout(() => {
      void runPreview(text, filename);
    }, REPREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, filename, runPreview]);

  const commitMutation = useMutation({
    mutationFn: commitImport,
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: contentTreeKey });
      void queryClient.invalidateQueries({
        queryKey: libraryInvalidations.listsPrefix,
      });
      // 导入内容归属资源库，成功后跳资源库页（带成功提示 state）
      navigate("/t/library", {
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
    <div className="mt-4">
      {/* 统计条（版本徽章 + 单元/讲义/题数 + 题型分布） */}
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
            {input.path.length > 0 ? ` · ${input.path}` : ""}
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

      {/* 动作清单 + 注意事项（D18/D19） */}
      {preview !== null ? <ActionsPanel preview={preview} /> : null}

      {/* lint 问题面板 + 复制错误给 AI（D21 新格式） */}
      {displayedIssues.length > 0 ? (
        <ErrorPanel
          path={input.path}
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
            onBack();
            setCommitIssues(null);
            setCommitError(null);
          }}
        >
          <ArrowLeft aria-hidden />
          返回重新选择
        </Button>
        <Button
          type="button"
          className="min-h-11 px-6"
          disabled={!canCommit}
          onClick={() => {
            setCommitError(null);
            commitMutation.mutate({
              markdown: text,
              filename,
              ...(options.folderId !== null
                ? { folderId: options.folderId }
                : {}),
              ...(input.path.length > 0 ? { sourcePath: input.path } : {}),
              ...(options.addToCourse !== undefined
                ? { addToCourse: options.addToCourse }
                : {}),
            });
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
  );
}

/** 顶部统计条：版本徽章 + 单元/讲义/题数 + 题型分布（单文件与批量展开共用） */
export function StatsBar({
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
