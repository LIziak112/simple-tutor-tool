import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ImportCommitRequest,
  ImportPreviewData,
  LintIssue,
} from "@tutor/contract";
import {
  ArrowLeft,
  ArrowLeftRight,
  CircleAlert,
  Images,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ActionsPanel,
  describeImportNames,
} from "@/features/content/ActionsPanel";
import { parseApiIssues } from "@/features/content/api-issues";
import { contentTreeKey } from "@/features/content/content-queries";
import { ErrorPanel } from "@/features/content/ErrorPanel";
import { lintIssuesToDiagnostics } from "@/features/content/lint-diagnostics";
import { QUESTION_TYPE_LABELS } from "@/features/content/question-meta";
import {
  libraryInvalidations,
  useLibraryFolders,
  useLibraryLectures,
} from "@/features/library/library-queries";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { ApiError, commitImport, previewImport } from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";
import type { ImportMediaSummary, ImportOptions } from "./ImportPage";
import { MarkdownEditor } from "./MarkdownEditor";

/**
 * 单文件导入预览（T1.11 的预览态；T2A.3 从 ImportPage 拆出并接入资源库选项）：
 * - 左 CodeMirror（Markdown 高亮 + lint 标注），右 RichMarkdown 渲染；
 * - 文件名预览态可就地修改（2026-10 审核修复；改名走同一条 debounce 重预览链路，
 *   实际存储标题来自 frontmatter 的提示见编辑器头）；
 * - 顶部统计条（单元/讲义/题数/题型分布）；
 * - 动作清单与注意事项面板（D18/D19，T2A.3）；
 * - 编辑即校验：预览态下改动 400ms debounce 重新调 preview；
 * - 有 error 时「确认导入」禁用并显示错误面板（「复制错误给 AI」按 D21 新格式）；
 *   commit 422 的 _issues 也进同一面板；成功跳 /t/library（带成功提示）。
 * - 替换指认（讲练文档 SSOT P2a）：lesson 文档将新建讲练页时，下方提供「替换
 *   既有讲练页」选择器（候选 = 讲义库 kind=lesson 行）；选中即带 replaceLectureId
 *   沿同一条 debounce 链路重新 preview（动作变 updateLecture + 接管 warning，由
 *   服务端计算），commit 复用同值，提交前弹层明示后果。批量导入不提供此入口。
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
  /** 随行图片汇总（md ×N / 自动上传图片 ×N 成功失败分列；null 或无实质内容不渲染） */
  readonly mediaSummary?: ImportMediaSummary | null;
  readonly onBack: () => void;
}

export function SingleImportPreview({
  input,
  options,
  mediaSummary = null,
  onBack,
}: SingleImportPreviewProps) {
  const [text, setText] = useState(input.markdown);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** commit 422 附带的 issue 列表（非空时覆盖 preview.issues 展示） */
  const [commitIssues, setCommitIssues] = useState<LintIssue[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  // 文件名预览态可改（2026-10 审核修复：此前只读，选错名只能回磁盘改文件重选）；
  // 改名触发 debounce 重新预览（与内容编辑同一条 400ms 链路）
  const [filename, setFilename] = useState(input.filename);
  // 替换指认（P2a）：教师指认的替换目标讲练页 id；选中即随同一条 debounce 链路
  // 重新 preview（服务端把动作改为 updateLecture 并亮接管 warning），commit 复用
  const [replaceLectureId, setReplaceLectureId] = useState<string | null>(null);
  // 已指认替换时的提交确认弹层（明示后果：旧随堂练习进回收站等）
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);

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
          ...(replaceLectureId !== null ? { replaceLectureId } : {}),
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
    [input.path, options.folderId, replaceLectureId],
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
      // 导入内容归属资源库，成功后跳资源库页（带成功提示 state）；
      // 讲练页按「一件事」汇报，不单列单元数
      navigate("/t/library", {
        state: {
          importSuccess:
            report.kind === "lesson"
              ? `导入完成：讲练页 ${report.lectures.length} 篇（新增 ${report.lectures.filter((l) => l.inserted).length} / 更新 ${report.lectures.filter((l) => l.updated).length}），随堂练习题新增 ${report.questions.inserted} / 更新 ${report.questions.updated}。`
              : `导入完成：单元 ${report.units.length} 个（新增 ${report.units.filter((u) => u.inserted).length} / 更新 ${report.units.filter((u) => u.updated).length}），讲义 ${report.lectures.length} 篇，题目新增 ${report.questions.inserted} / 更新 ${report.questions.updated}。`,
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

  const canCommit =
    preview !== null &&
    !hasError &&
    !previewPending &&
    previewError === null &&
    !commitMutation.isPending &&
    text.trim().length > 0 &&
    filename.trim().length > 0;

  // 替换指认入口（P2a）的可见性：lesson 文档且动作含 createLecture（将新建讲练页）
  // 时展示；已指认（replaceLectureId 非空）时保持可见——重新预览后动作已变
  // updateLecture，用户仍可换目标或清除；带目标重新预览失败（REPLACE_* 错误走
  // 通用错误面板）时也保留，便于改选/清除后自动重试
  const createsLecture =
    preview !== null &&
    (preview.summary.kind ?? "practice") === "lesson" &&
    preview.actions.some((action) => action.kind === "createLecture");
  const showReplaceSelector = createsLecture || replaceLectureId !== null;

  /** commit 请求体（与 preview 同字段；replaceLectureId 只在已指认时携带） */
  function buildCommitRequest(): ImportCommitRequest {
    return {
      markdown: text,
      filename,
      ...(options.folderId !== null ? { folderId: options.folderId } : {}),
      ...(input.path.length > 0 ? { sourcePath: input.path } : {}),
      ...(options.addToCourse !== undefined
        ? { addToCourse: options.addToCourse }
        : {}),
      ...(replaceLectureId !== null ? { replaceLectureId } : {}),
    };
  }

  return (
    <div className="mt-4">
      {/* 统计条（单元/讲义/题数 + 题型分布） */}
      <StatsBar
        preview={preview}
        pending={previewPending}
        error={previewError}
        onRetry={() => void runPreview(text, filename)}
      />

      {/* 随行图片汇总（选择阶段选过图片才渲染；单文件与批量预览同款） */}
      <ImportMediaSummaryCard summary={mediaSummary} />

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
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium">
              原文（带 lint 标注，编辑后自动重新校验）
            </span>
            {input.path.length > 0 ? (
              <span
                className="min-w-0 max-w-64 truncate"
                title={input.path}
              >{` · ${input.path}`}</span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <Input
                aria-label="导入文件名"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="文件名.md"
                className="h-9 w-48 text-xs"
              />
              文件名可改
            </span>
            <span
              title="文件名用于导入留档显示；单元 / 讲义的实际存储标题以文档开头 frontmatter（unit: / title:）为准，可在下方编辑器修改"
              className="ml-auto cursor-help underline decoration-dotted underline-offset-2"
            >
              单元 / 讲义标题来自文档开头 frontmatter
            </span>
          </div>
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
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl">
              <RichMarkdown source={text} />
            </div>
          </div>
        </div>
      </div>

      {/* 动作清单 + 注意事项（D18/D19） */}
      {preview !== null ? <ActionsPanel preview={preview} /> : null}

      {/* 替换既有讲练页指认（P2a）：lesson 新建讲练页时出现（见可见性注释） */}
      {showReplaceSelector ? (
        <ReplaceLectureSelector
          selectedId={replaceLectureId}
          onSelect={setReplaceLectureId}
        />
      ) : null}

      {/* lint 问题面板 + 复制错误给 AI（D21 新格式） */}
      {displayedIssues.length > 0 ? (
        <ErrorPanel
          path={input.path}
          markdown={text}
          issues={displayedIssues}
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
            // 已指认替换：先弹层明示后果，确认后才提交（P2a）
            if (replaceLectureId !== null) {
              setReplaceConfirmOpen(true);
              return;
            }
            commitMutation.mutate(buildCommitRequest());
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

      {/* 替换确认弹层（P2a：与就地新建文件夹同款形态；明示替换后果） */}
      {replaceConfirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="replace-confirm-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-4 shadow-lg">
            <h3
              id="replace-confirm-heading"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <ArrowLeftRight
                aria-hidden
                className="size-4 text-muted-foreground"
              />
              确认替换讲练页
            </h3>
            <p className="mt-2 text-sm leading-relaxed">
              将替换所选讲练页：旧随堂练习进回收站、已交卷与进行中作答不受影响、课程目录引用保留。
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              替换后该页标题与正文以本文档为准（对应上方「更新讲练页」动作）。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => setReplaceConfirmOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                className="min-h-11 px-4"
                onClick={() => {
                  setReplaceConfirmOpen(false);
                  commitMutation.mutate(buildCommitRequest());
                }}
              >
                确认替换
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 顶部统计条：单元/讲义/题数 + 实际存储名（方案 §5）+ 题型分布（单文件与批量展开共用） */
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
  // 讲练页（kind=lesson）：统计条按「讲练页 + 题目」呈现，不单列单元数
  const docKind = summary?.kind ?? "practice";
  // 「文件 → 存储名」实际名称（方案 §5：计数旁亮出单元/讲义名；无动作不显示；
  // lesson 只报讲练页名——嵌入单元不单独显示）
  const names =
    preview === null ? null : describeImportNames(preview.actions, docKind);
  const nameParts =
    names === null
      ? []
      : [names.unit, names.lecture].filter(
          (part): part is string => part !== null,
        );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      {summary !== undefined ? (
        <>
          {docKind === "lesson" ? (
            <span>
              讲练页 <strong>{summary.lectureCount}</strong>
            </span>
          ) : (
            <>
              <span>
                单元 <strong>{summary.unitCount}</strong>
              </span>
              <span>
                讲义 <strong>{summary.lectureCount}</strong>
              </span>
            </>
          )}
          <span>
            题目 <strong>{summary.questionCount}</strong>
          </span>
          {/* tt-06b / QM-05：材料/组单列计数——题目口径不把父组/材料重复算题 */}
          {summary.materialCount !== undefined && summary.materialCount > 0 ? (
            <span>
              材料 <strong>{summary.materialCount}</strong>
            </span>
          ) : null}
          {summary.groupCount !== undefined && summary.groupCount > 0 ? (
            <span>
              题组 <strong>{summary.groupCount}</strong>
            </span>
          ) : null}
          {nameParts.length > 0 ? (
            <span
              className="min-w-0 max-w-72 truncate text-muted-foreground"
              title={nameParts.join(" · ")}
            >
              {nameParts.join(" · ")}
            </span>
          ) : null}
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

/**
 * 随行图片汇总卡（单文件与批量预览共用，媒体管线第四单）：
 * 预览/确认步骤给用户对账——本批 md ×N、识别并自动上传关联图片 ×N（成功/失败
 * 分列、失败附原因逐张列出）、未配对/失败的引用保持原样并在预览中由服务端
 * 核对提示。无实质内容（没传图片相关环节）时返回 null 不占位。
 */
export function ImportMediaSummaryCard({
  summary,
}: {
  readonly summary: ImportMediaSummary | null;
}) {
  if (
    summary === null ||
    (summary.imageCount === 0 &&
      summary.failed.length === 0 &&
      summary.unresolvedCount === 0)
  ) {
    return null;
  }
  return (
    <section
      aria-label="随行图片汇总"
      className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <Images aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        本批将导入 Markdown {summary.mdCount} 份，识别并自动上传关联图片{" "}
        {summary.imageCount} 张（成功 {summary.uploadedCount} / 失败{" "}
        {summary.failed.length}）。
      </p>
      {summary.failed.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-8 text-xs text-destructive">
          {summary.failed.map((item) => (
            <li key={`${item.name}-${item.reason}`}>
              {item.name}：{item.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {summary.unresolvedCount > 0
          ? `未配对或上传失败的引用 ${summary.unresolvedCount} 处将保持原样；预览时服务端会逐条核对引用的图片，缺失的将以警告提示（不影响导入其余内容）。`
          : "全部引用已替换为服务器路径。"}
      </p>
    </section>
  );
}

/**
 * 「替换既有讲练页」指认（讲练文档 SSOT P2a）：单文件导入 lesson 文档将新建
 * 讲练页时，教师可指认要替换的既有讲练页（改名重导 / 换页重导场景）。选中即由
 * 父组件带 replaceLectureId 重新 preview（动作变 updateLecture + 接管 warning，
 * 服务端计算，前端不自行判定），提交前另有后果确认弹层。
 * 候选来自讲义库列表（GET /api/teacher/library/lectures，前端过滤 kind=lesson），
 * 展示 标题 / 所在文件夹 / 更新时间（相对时间）。批量导入不提供此入口。
 */
function ReplaceLectureSelector({
  selectedId,
  onSelect,
}: {
  /** 已指认的目标 id；null = 未指认（缺省选项） */
  readonly selectedId: string | null;
  /** 选中目标（空串清除指认 → null） */
  readonly onSelect: (id: string | null) => void;
}) {
  const lecturesQuery = useLibraryLectures({});
  const foldersQuery = useLibraryFolders();
  /** 文件夹 id → 名（未归类与文件夹行缺失都兜底「未归类」，与服务端同口径） */
  const folderNameById = useMemo(
    () =>
      new Map(
        (foldersQuery.data?.folders ?? []).map((folder) => [
          folder.id,
          folder.name,
        ]),
      ),
    [foldersQuery.data],
  );
  const lessons = useMemo(
    () =>
      (lecturesQuery.data?.lectures ?? []).filter(
        (row) => row.kind === "lesson",
      ),
    [lecturesQuery.data],
  );
  const loadError = lecturesQuery.isError
    ? lecturesQuery.error
    : foldersQuery.error;

  // 三态齐全（加载 / 错误可重试 / 空态），不许白屏或缺出口
  if (lecturesQuery.isPending || foldersQuery.isPending) {
    return (
      <section
        aria-label="替换既有讲练页"
        className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在加载讲练页列表…
        </span>
      </section>
    );
  }
  if (lecturesQuery.isError || foldersQuery.isError) {
    return (
      <section
        aria-label="替换既有讲练页"
        className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
      >
        <p role="alert" className="text-destructive">
          讲练页列表加载失败：
          {loadError instanceof Error ? loadError.message : "请稍后重试"}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-2 min-h-11 w-fit px-3 text-xs"
          onClick={() => {
            void lecturesQuery.refetch();
            void foldersQuery.refetch();
          }}
        >
          <RefreshCw aria-hidden />
          重试
        </Button>
      </section>
    );
  }
  if (lessons.length === 0) {
    return (
      <section
        aria-label="替换既有讲练页"
        className="mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
      >
        库中还没有讲练页，本次将新建讲练页。
      </section>
    );
  }
  return (
    <section
      aria-labelledby="replace-lecture-heading"
      className="mt-3 rounded-xl border border-border bg-card p-4"
    >
      <h2
        id="replace-lecture-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <ArrowLeftRight aria-hidden className="size-4 shrink-0 text-primary" />
        替换既有讲练页
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        本文档将新建讲练页。若它是某页讲练页改名或调整后的重导，可指认要替换的
        既有讲练页：预览将变为「更新讲练页」并提示接管影响，提交时绑定该页更新
        （标题与正文以本文档为准）。
      </p>
      <label
        htmlFor="replace-lecture-select"
        className="mt-2 block text-sm font-medium"
      >
        替换目标
      </label>
      <select
        id="replace-lecture-select"
        value={selectedId ?? ""}
        onChange={(e) =>
          onSelect(e.target.value === "" ? null : e.target.value)
        }
        className="min-h-11 w-full max-w-md rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">不替换（新建讲练页）</option>
        {lessons.map((row) => (
          <option key={row.id} value={row.id}>
            {`${row.title} · ${row.folderId === null ? "未归类" : (folderNameById.get(row.folderId) ?? "未归类")} · ${formatRelativeTime(row.updatedAt)}`}
          </option>
        ))}
      </select>
    </section>
  );
}
