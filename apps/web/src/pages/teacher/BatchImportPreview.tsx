import { useQueryClient } from "@tanstack/react-query";
import type {
  ImportBatchFilePreview,
  ImportCommitData,
  ImportPreviewBatchData,
} from "@tutor/contract";
import { v1ToV2 } from "@tutor/md-dsl";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ActionsPanel,
  formatImportAction,
} from "@/features/content/ActionsPanel";
import { contentTreeKey } from "@/features/content/content-queries";
import { ErrorPanel } from "@/features/content/ErrorPanel";
import { buildFixPrompt } from "@/features/content/error-prompt";
import { lintIssuesToDiagnostics } from "@/features/content/lint-diagnostics";
import { useClipboardCopy } from "@/features/content/use-clipboard";
import { libraryInvalidations } from "@/features/library/library-queries";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { commitImport, previewImportBatch } from "@/lib/api";
import type { ImportOptions, PickedFile } from "./ImportPage";
import { MarkdownEditor } from "./MarkdownEditor";
import { StatsBar } from "./SingleImportPreview";

/**
 * 批量导入预览与提交（T2A.3，D20）：
 * - 文件表格：相对路径、类型摘要（讲义/单元/题数）、error 数（lint + 跨文件冲突）、
 *   warning 数（lint + 导入 warning）、动作摘要、目标文件夹、提交状态；
 * - 点击一行展开单文件预览（CodeMirror 标红 + 渲染 + 统计 + 动作清单 + 错误面板）；
 * - 提交：**每个文件独立调用 commit**（顺序执行显示进度），有 error 的文件自动
 *   跳过、失败继续下一个；结束后给出汇总报告（成功 n / 跳过 n / 失败 n）；
 * - 失败/跳过文件保留在列表中，修正后可「重新预览」再提交（batchId 不变，
 *   GET /api/teacher/import/batches/:batchId 可回看服务端记录）；
 * - 「复制全部错误给 AI」：仅有 error 的文件（D21 新格式：路径 + 错误 + ±3 行片段）。
 */

/** 单文件的提交状态（前端逐文件顺序提交的进度记录） */
interface FileCommitState {
  readonly status: "pending" | "running" | "success" | "skipped" | "failed";
  /** 中文说明（跳过/失败原因、成功摘要） */
  readonly message?: string;
  readonly report?: ImportCommitData;
}

/** 汇总报告（前端生成，D20） */
interface BatchReport {
  readonly success: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface BatchImportPreviewProps {
  readonly files: readonly PickedFile[];
  readonly options: ImportOptions;
  /** 按子目录自动建文件夹（D20） */
  readonly autoSubdir: boolean;
  readonly onBack: () => void;
}

export function BatchImportPreview({
  files,
  options,
  autoSubdir,
  onBack,
}: BatchImportPreviewProps) {
  // batchId 在本组件生命周期内保持不变（重新预览不换批次，服务端按它聚合留档）
  const [batchId] = useState(() => crypto.randomUUID());
  const [data, setData] = useState<ImportPreviewBatchData | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [commitStates, setCommitStates] = useState<
    Record<string, FileCommitState>
  >({});
  const [committing, setCommitting] = useState(false);
  const [report, setReport] = useState<BatchReport | null>(null);
  const markdownByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file.markdown] as const)),
    [files],
  );
  const queryClient = useQueryClient();

  const runPreview = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const result = await previewImportBatch({
        ...(options.folderId !== null ? { folderId: options.folderId } : {}),
        autoFolderBySubdir: autoSubdir,
        files: files.map((file) => ({
          path: file.path,
          markdown: file.markdown,
        })),
      });
      setData(result);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "批量预览失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }, [autoSubdir, files, options.folderId]);

  // 进入即预览
  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  function setFileState(path: string, state: FileCommitState): void {
    setCommitStates((prev) => ({ ...prev, [path]: state }));
  }

  /** 顺序提交全部文件（D20：每文件独立事务，失败继续下一个） */
  async function handleCommitAll(): Promise<void> {
    if (data === null || committing) return;
    setCommitting(true);
    let success = 0;
    let skipped = 0;
    let failed = 0;
    for (const file of data.files) {
      if (file.hasError) {
        setFileState(file.path, {
          status: "skipped",
          message:
            file.conflicts.length > 0
              ? `跨文件冲突：${file.conflicts[0]?.message ?? ""}`
              : "文件存在 error 级问题，自动跳过",
        });
        skipped += 1;
        continue;
      }
      setFileState(file.path, { status: "running" });
      try {
        const result = await commitImport({
          markdown: markdownByPath.get(file.path) ?? "",
          filename: basenameOf(file.path),
          ...(file.folderToCreate && file.folderName !== null
            ? { folderName: file.folderName }
            : file.folderId !== null
              ? { folderId: file.folderId }
              : {}),
          sourcePath: file.path,
          batchId,
          ...(options.addToCourse !== undefined
            ? { addToCourse: options.addToCourse }
            : {}),
        });
        setFileState(file.path, {
          status: "success",
          message: `单元 ${result.units.length} / 讲义 ${result.lectures.length}，题目新增 ${result.questions.inserted} / 更新 ${result.questions.updated}`,
          report: result,
        });
        success += 1;
      } catch (err) {
        setFileState(file.path, {
          status: "failed",
          message: err instanceof Error ? err.message : "导入失败，请稍后重试",
        });
        failed += 1;
      }
    }
    setReport({ success, skipped, failed });
    setCommitting(false);
    void queryClient.invalidateQueries({ queryKey: contentTreeKey });
    void queryClient.invalidateQueries({
      queryKey: libraryInvalidations.listsPrefix,
    });
  }

  function handleRepreview(): void {
    setCommitStates({});
    setReport(null);
    setExpandedPath(null);
    void runPreview();
  }

  const errorFiles = (data?.files ?? []).filter((file) => file.hasError);
  const clipboard = useClipboardCopy();
  const allPrompt =
    errorFiles.length > 0
      ? buildFixPrompt(
          errorFiles.map((file) => ({
            path: file.path,
            markdown: markdownByPath.get(file.path) ?? "",
            issues: file.preview.issues,
            version: file.preview.version,
          })),
        )
      : "";
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  // 降级弹层打开时聚焦并全选；Escape 关闭
  useEffect(() => {
    if (clipboard.fallbackText === null) return;
    fallbackTextareaRef.current?.focus();
    fallbackTextareaRef.current?.select();
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") clipboard.closeFallback();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clipboard]);

  return (
    <div className="mt-4">
      {/* 顶部操作条 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-sm font-semibold">
            批量导入（{files.length} 个文件）
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            批次 {batchId.slice(0, 8)}… ·
            {autoSubdir ? " 按子目录建文件夹 ·" : ""}
            {options.folderId !== null ? " 目标文件夹已选 ·" : " 目标未归类 ·"}
            {options.addToCourse !== undefined ? " 同时加入课程" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {errorFiles.length > 0 ? (
            <Button
              ref={clipboard.buttonRef}
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              onClick={() => void clipboard.copy(allPrompt)}
            >
              <Copy aria-hidden />
              复制全部错误给 AI（{errorFiles.length} 个文件）
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            onClick={handleRepreview}
            disabled={pending || committing}
          >
            <RefreshCw aria-hidden />
            重新预览
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            onClick={onBack}
            disabled={committing}
          >
            <ArrowLeft aria-hidden />
            返回重新选择
          </Button>
          <Button
            type="button"
            className="min-h-11 px-6"
            disabled={data === null || pending || committing}
            onClick={() => void handleCommitAll()}
          >
            {committing ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                正在导入…
              </>
            ) : (
              <>
                <Upload aria-hidden />
                导入全部
                {errorFiles.length > 0
                  ? `（跳过 ${errorFiles.length} 个有错误的）`
                  : ""}
              </>
            )}
          </Button>
        </div>
      </div>

      {clipboard.copied ? (
        <p
          role="status"
          className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          已复制提示词（仅含有错误的文件：路径 + 错误 + 片段），粘贴给任意 AI
          助手即可。
        </p>
      ) : null}

      {/* 三态：加载 / 错误 / 表格 */}
      {pending && data === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在批量分析 {files.length} 个文件…
        </p>
      ) : null}

      {error !== null ? (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">批量预览失败：{error}</p>
          <Button
            variant="outline"
            className="min-h-11 px-4"
            onClick={() => void runPreview()}
          >
            重试
          </Button>
        </div>
      ) : null}

      {/* 汇总报告（D20：前端生成；失败/跳过文件保留在列表中可重新预览） */}
      {report !== null ? (
        <div
          role="status"
          className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
        >
          <p className="font-semibold">
            导入完成：成功 {report.success} / 跳过 {report.skipped} / 失败{" "}
            {report.failed}
          </p>
          {report.skipped + report.failed > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              跳过与失败的文件保留在下方列表；修正文件内容后点「重新预览」可再次提交
              （仍属同一批次，可回看服务端记录）。
            </p>
          ) : null}
        </div>
      ) : null}

      {data !== null ? (
        <div className="mt-3 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs">
                <th scope="col" className="w-10 px-2 py-2" />
                <th scope="col" className="px-2 py-2 font-medium">
                  文件
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  内容
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  错误
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  警告
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  动作
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  目标文件夹
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  状态
                </th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((file) => (
                <BatchFileRow
                  key={file.path}
                  file={file}
                  markdown={markdownByPath.get(file.path) ?? ""}
                  state={commitStates[file.path] ?? { status: "pending" }}
                  expanded={expandedPath === file.path}
                  onToggle={() =>
                    setExpandedPath(
                      expandedPath === file.path ? null : file.path,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* 剪贴板不可用的降级弹层（全选 + 手动复制） */}
      {clipboard.fallbackText !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-copy-fallback-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card p-4 shadow-lg">
            <div className="flex items-center justify-between gap-3">
              <h3
                id="batch-copy-fallback-heading"
                className="text-sm font-semibold"
              >
                剪贴板不可用，请手动复制
              </h3>
              <button
                type="button"
                aria-label="关闭弹层"
                onClick={clipboard.closeFallback}
                className="flex size-8 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              全选下方提示词后按 Ctrl+C 复制，粘贴给 AI 即可。
            </p>
            <textarea
              ref={fallbackTextareaRef}
              readOnly
              value={clipboard.fallbackText}
              aria-label="提示词全文"
              className="mt-2 min-h-48 w-full flex-1 resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => {
                  fallbackTextareaRef.current?.focus();
                  fallbackTextareaRef.current?.select();
                }}
              >
                全选
              </Button>
              <Button
                type="button"
                className="min-h-11 px-4"
                onClick={clipboard.closeFallback}
              >
                关闭
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 表格行 + 展开的单文件预览（CodeMirror 标红 + 渲染 + 统计 + 动作清单 + 错误面板） */
function BatchFileRow({
  file,
  markdown,
  state,
  expanded,
  onToggle,
}: {
  file: ImportBatchFilePreview;
  markdown: string;
  state: FileCommitState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lintErrors = file.preview.issues.filter(
    (issue) => issue.level === "error",
  ).length;
  const errorCount = lintErrors + file.conflicts.length;
  const warningCount =
    file.preview.issues.length - lintErrors + file.preview.warnings.length;
  const actionSummary =
    file.preview.actions.length === 0
      ? "（无内容）"
      : `${formatImportAction(file.preview.actions[0] as never)}${
          file.preview.actions.length > 1
            ? ` 等 ${file.preview.actions.length} 项`
            : ""
        }`;
  const diagnostics = useMemo(
    () => lintIssuesToDiagnostics(file.preview.issues, markdown),
    [file.preview.issues, markdown],
  );
  const renderSource = file.preview.version === 1 ? v1ToV2(markdown) : markdown;

  return (
    <>
      <tr
        className={`border-b border-border ${errorCount > 0 ? "bg-destructive/5" : ""}`}
      >
        <td className="px-2 py-2 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `收起 ${file.path}` : `展开 ${file.path}`}
            className="flex size-11 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="size-4" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )}
          </button>
        </td>
        <td className="max-w-56 px-2 py-2 align-top">
          <span
            className={`block truncate font-mono text-xs ${errorCount > 0 ? "text-destructive" : ""}`}
            title={file.path}
          >
            {file.path}
          </span>
        </td>
        <td className="px-2 py-2 align-top text-xs">{describeSummary(file)}</td>
        <td className="px-2 py-2 align-top">
          {errorCount > 0 ? (
            <span className="font-medium text-destructive">{errorCount}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </td>
        <td className="px-2 py-2 align-top">
          {warningCount > 0 ? (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {warningCount}
            </span>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </td>
        <td className="max-w-64 px-2 py-2 align-top text-xs">
          <span
            className="line-clamp-2 text-muted-foreground"
            title={actionSummary}
          >
            {actionSummary}
          </span>
        </td>
        <td className="px-2 py-2 align-top text-xs">
          {file.folderName === null
            ? "未归类"
            : `${file.folderName}${file.folderToCreate ? "（将新建）" : ""}`}
        </td>
        <td className="px-2 py-2 align-top text-xs">
          <CommitStateBadge state={state} />
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border">
          <td colSpan={8} className="bg-muted/20 px-3 py-3">
            {/* 跨文件冲突（D20：视为 error） */}
            {file.conflicts.length > 0 ? (
              <div
                role="alert"
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {file.conflicts.map((conflict) => (
                  <p key={`${conflict.code}-${conflict.otherPath}`}>
                    与「{conflict.otherPath}」冲突：{conflict.message}
                  </p>
                ))}
              </div>
            ) : null}

            <StatsBar
              preview={file.preview}
              pending={false}
              error={null}
              onRetry={() => undefined}
            />

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="flex h-[50vh] flex-col overflow-hidden rounded-xl border border-border bg-card">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  原文（带 lint 标注，只读——请修正源文件后重新预览）
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <MarkdownEditor
                    value={markdown}
                    onChange={() => undefined}
                    diagnostics={diagnostics}
                  />
                </div>
              </div>
              <div className="flex h-[50vh] flex-col overflow-hidden rounded-xl border border-border bg-card">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  渲染预览
                  {file.preview.version === 1 &&
                    "（v1 文档已自动转换为 v2 后渲染）"}
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="mx-auto max-w-3xl">
                    <RichMarkdown source={renderSource} />
                  </div>
                </div>
              </div>
            </div>

            <ActionsPanel preview={file.preview} />

            {file.preview.issues.length > 0 ? (
              <ErrorPanel
                path={file.path}
                markdown={markdown}
                issues={file.preview.issues}
                version={file.preview.version}
              />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** 提交状态徽章 */
function CommitStateBadge({ state }: { state: FileCommitState }) {
  switch (state.status) {
    case "success":
      return (
        <span
          className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300"
          title={state.message}
        >
          <CheckCircle2 aria-hidden className="size-3.5" />
          成功
        </span>
      );
    case "skipped":
      return (
        <span
          className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400"
          title={state.message}
        >
          <CircleAlert aria-hidden className="size-3.5" />
          跳过
        </span>
      );
    case "failed":
      return (
        <span
          className="inline-flex items-center gap-1 font-medium text-destructive"
          title={state.message}
        >
          <CircleAlert aria-hidden className="size-3.5" />
          失败
        </span>
      );
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          导入中…
        </span>
      );
    default:
      return <span className="text-muted-foreground">待导入</span>;
  }
}

/** 摘要 → 「讲义 x 篇 / 单元 x · 题 y」短文案（识别出的类型，D20 表格列） */
function describeSummary(file: ImportBatchFilePreview): string {
  const { summary } = file.preview;
  const parts: string[] = [];
  if (summary.lectureCount > 0) parts.push(`讲义 ${summary.lectureCount}`);
  if (summary.unitCount > 0)
    parts.push(`单元 ${summary.unitCount} · 题 ${summary.questionCount}`);
  return parts.length > 0 ? parts.join(" / ") : "（空文档）";
}

/** path → basename（跨平台分隔符） */
function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1
    ? normalized
    : (normalized.slice(index + 1) ?? normalized);
}
