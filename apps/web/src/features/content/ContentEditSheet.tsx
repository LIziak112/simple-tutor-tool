import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LintIssue } from "@tutor/contract";
import {
  LECTURE_PREFIX_LINES,
  lintDocument,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import { CircleAlert, Loader2, PencilLine, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { parseApiIssues } from "@/features/content/api-issues";
import { contentTreeKey } from "@/features/content/content-queries";
import { ErrorPanel } from "@/features/content/ErrorPanel";
import { lintIssuesToDiagnostics } from "@/features/content/lint-diagnostics";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { PublishConfirmDialog } from "@/features/shared/PublishConfirmDialog";
import {
  ApiError,
  fetchLectureDetail,
  fetchQuestionDetail,
  updateLecture,
  updateQuestion,
} from "@/lib/api";
import { MarkdownEditor } from "@/pages/teacher/MarkdownEditor";

/**
 * 题目/讲义编辑抽屉（T1.12）：
 * - 上部 CodeMirror（复用 MarkdownEditor + lint 诊断映射，错误行标红）+ 右侧
 *   RichMarkdown 实时预览；编辑 400ms debounce 后本地 lintDocument 即时标注
 *   （与服务端同一套包装语境，见 md-dsl edit-context），提交时服务端终审；
 * - 单题编辑的本地校验：error 级 issue / 0 题 / 多题 / id 变化（提示题目 id 不可变），
 *   命中任一即禁用保存；讲义编辑：error 级 issue / H1 数不为 1；
 * - 422（LINT_ERROR 附 _issues / ID_IMMUTABLE / VALIDATION_ERROR）回显抽屉内错误面板；
 * - 保存成功后停留在抽屉显示新版本号（题目）或新标题（讲义），父级刷新内容树。
 */

/** 编辑后自动重新 lint 的防抖时长 */
const LINT_DEBOUNCE_MS = 400;

/** 抽屉内错误面板需要的文件名（进入"复制错误给 AI"提示词） */
const filenameOf = (kind: "题目" | "讲义", id: string): string =>
  `${kind}-${id}.md`;

/** 合成 warning（本地单题编辑校验：题数/id 与服务端同一套中文口径） */
function warn(line: number, message: string): LintIssue {
  return { level: "warning", line, column: 1, code: "EDIT_CHECK", message };
}

// ---------- 题目编辑抽屉 ----------

export interface QuestionEditSheetProps {
  /** 待编辑题目 id（抽屉打开期间不变） */
  questionId: string;
  /** 关闭抽屉（父组件清空 editingQuestionId） */
  onClose: () => void;
}

export function QuestionEditSheet({
  questionId,
  onClose,
}: QuestionEditSheetProps) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["teacher", "question", questionId] as const,
    queryFn: () => fetchQuestionDetail(questionId),
    retry: false,
  });

  const [text, setText] = useState("");
  const [textTouched, setTextTouched] = useState(false);
  const [debouncedText, setDebouncedText] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<LintIssue[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  // 详情就绪后初始化编辑器内容（仅首次，避免保存后回填覆盖输入）；
  // debounce 值同步初始化，抽屉打开即可保存（不必等第一次 debounce 到期）
  useEffect(() => {
    if (detailQuery.data !== undefined && !textTouched) {
      setText(detailQuery.data.sourceMd);
      setDebouncedText(detailQuery.data.sourceMd);
    }
  }, [detailQuery.data, textTouched]);

  // 400ms debounce 本地 lint（与服务端同一套包装语境）
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), LINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const check = useMemo(() => {
    const data = detailQuery.data;
    if (data === undefined || debouncedText === null) return null;
    const wrapped = wrapSingleQuestionMd(data.unitId, debouncedText);
    const { parsed, issues } = lintDocument(wrapped, {
      unitId: data.unitId,
      questionStartNumber: data.order + 1,
    });
    const local = shiftLintIssuesToFragment(
      issues,
      SINGLE_QUESTION_PREFIX_LINES,
    );
    const questions = parsed.units.flatMap((unit) => unit.questions);
    const extra: LintIssue[] = [];
    if (
      questions.length === 0 &&
      // 空练习守卫（PRACTICE_NO_QUESTIONS）已就该条件报 error（与服务端拒绝一致），
      // 不再叠加同义 warning；此分支只作 lint 缺位时的兜底提示
      !local.some((issue) => issue.code === "PRACTICE_NO_QUESTIONS")
    ) {
      extra.push(
        warn(
          1,
          "未解析出任何题目：请保留完整的 ::::question 容器（含题干与结束围栏 ::::）",
        ),
      );
    } else if (questions.length > 1) {
      extra.push(
        warn(
          1,
          `一次只能编辑一道题（当前解析出 ${questions.length} 道）；如需新增题目请走导入`,
        ),
      );
    } else if (questions[0]?.id !== data.id) {
      extra.push(
        warn(
          1,
          `题目 id 不可变（原 id「${data.id}」，当前解析出「${questions[0]?.id}」）；如需新增题目请走导入`,
        ),
      );
    }
    const all = [...local, ...extra];
    return {
      questions,
      issues: all,
      hasError:
        issues.some((issue) => issue.level === "error") ||
        questions.length !== 1 ||
        questions[0]?.id !== data.id,
      wrapped,
    };
  }, [detailQuery.data, debouncedText]);

  const saveMutation = useMutation({
    mutationFn: () => updateQuestion(questionId, { sourceMd: text }),
    onSuccess: (result) => {
      setServerIssues(null);
      setServerError(null);
      void queryClient.invalidateQueries({ queryKey: contentTreeKey });
      void queryClient.invalidateQueries({
        queryKey: ["teacher", "question", questionId],
      });
      // result.version 供成功提示展示（保持打开，教师可继续微调）
      setSavedHint(`已保存为 v${result.version}（题目 id 不变）`);
    },
    onError: (err) => {
      setSavedHint(null);
      if (err instanceof ApiError && err.code === "LINT_ERROR") {
        setServerIssues(parseApiIssues(err.extra));
        setServerError(err.message);
        return;
      }
      setServerIssues(null);
      setServerError(
        err instanceof Error ? err.message : "保存失败，请稍后重试",
      );
    },
  });

  const displayedIssues = serverIssues ?? check?.issues ?? [];
  const diagnostics = useMemo(
    () => lintIssuesToDiagnostics(displayedIssues, text),
    [displayedIssues, text],
  );

  const canSave = check !== null && !check.hasError && !saveMutation.isPending;

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PencilLine aria-hidden className="size-4 text-muted-foreground" />
            编辑题目
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {questionId}
          </SheetDescription>
        </SheetHeader>

        {detailQuery.isPending ? <SheetLoading /> : null}
        {detailQuery.isError ? (
          <SheetError
            message={
              detailQuery.error instanceof Error
                ? detailQuery.error.message
                : "加载失败"
            }
            onRetry={() => void detailQuery.refetch()}
          />
        ) : null}

        {detailQuery.data !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
              <div className="flex min-h-0 flex-col overflow-hidden border-r-0 border-border lg:border-r">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  原文（::::question 片段，编辑后自动校验）
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <MarkdownEditor
                    value={text}
                    onChange={(value) => {
                      setText(value);
                      setTextTouched(true);
                      // 再次编辑后：成功提示与服务端 422 回显失效，改看本地实时 lint
                      setSavedHint(null);
                      setServerIssues(null);
                      setServerError(null);
                    }}
                    diagnostics={diagnostics}
                  />
                </div>
              </div>
              <div className="flex min-h-0 flex-col overflow-hidden">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  渲染预览（题干/提示/详解）
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="mx-auto max-w-2xl">
                    <RichMarkdown
                      source={
                        check?.wrapped ??
                        wrapSingleQuestionMd(detailQuery.data.unitId, text)
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* 服务端 422 / 网络 error 回显 + 复制错误给 AI */}
            {serverError !== null ? (
              <p
                role="alert"
                className="flex items-start gap-2 border-t border-border bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {serverError}
              </p>
            ) : null}
            {displayedIssues.length > 0 ? (
              <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border">
                <ErrorPanel
                  path={filenameOf("题目", questionId)}
                  markdown={text}
                  issues={displayedIssues}
                />
              </div>
            ) : null}

            <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-4 py-3">
              <Button
                type="button"
                className="min-h-11 px-5"
                disabled={!canSave}
                onClick={() => {
                  setServerError(null);
                  setServerIssues(null);
                  saveMutation.mutate();
                }}
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    保存中…
                  </>
                ) : (
                  <>
                    <Save aria-hidden />
                    保存
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={onClose}
                disabled={saveMutation.isPending}
              >
                关闭
              </Button>
              {savedHint !== null ? (
                <p
                  role="status"
                  className="text-sm text-emerald-600 dark:text-emerald-400"
                >
                  {savedHint}
                </p>
              ) : null}
              {check?.hasError ? (
                <p className="text-sm text-destructive" role="alert">
                  存在错误或题数/id 不符，修正后才能保存。
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ---------- 讲义编辑抽屉 ----------

export interface LectureEditSheetProps {
  /** 待编辑讲义 id（数据库 uuid） */
  lectureId: string;
  onClose: () => void;
}

export function LectureEditSheet({
  lectureId,
  onClose,
}: LectureEditSheetProps) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["teacher", "lecture", lectureId] as const,
    queryFn: () => fetchLectureDetail(lectureId),
    retry: false,
  });

  const [text, setText] = useState("");
  const [textTouched, setTextTouched] = useState(false);
  const [debouncedText, setDebouncedText] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<LintIssue[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    if (detailQuery.data !== undefined && !textTouched) {
      setText(detailQuery.data.markdown);
      // debounce 值同步初始化，抽屉打开即可保存（与题目抽屉一致）
      setDebouncedText(detailQuery.data.markdown);
    }
  }, [detailQuery.data, textTouched]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), LINT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const check = useMemo(() => {
    const data = detailQuery.data;
    if (data === undefined || debouncedText === null) return null;
    const wrapped = wrapLectureMd(debouncedText);
    const { parsed, issues } = lintDocument(wrapped);
    const local = shiftLintIssuesToFragment(issues, LECTURE_PREFIX_LINES);
    const extra: LintIssue[] = [];
    if (parsed.lectures.length === 0) {
      extra.push(
        warn(1, "讲义必须以「# 标题」开头（title 从第一个 H1 重新提取）"),
      );
    } else if (parsed.lectures.length > 1) {
      extra.push(
        warn(
          1,
          `讲义只能包含一个 H1 标题（当前解析出 ${parsed.lectures.length} 篇）；如需多篇讲义请走导入`,
        ),
      );
    }
    return {
      title: parsed.lectures[0]?.title,
      issues: [...local, ...extra],
      hasError:
        issues.some((issue) => issue.level === "error") ||
        parsed.lectures.length !== 1,
      wrapped,
    };
  }, [detailQuery.data, debouncedText]);

  const saveMutation = useMutation({
    mutationFn: () => updateLecture(lectureId, { markdown: text }),
    onSuccess: (result) => {
      setServerIssues(null);
      setServerError(null);
      void queryClient.invalidateQueries({ queryKey: contentTreeKey });
      void queryClient.invalidateQueries({
        queryKey: ["teacher", "lecture", lectureId],
      });
      setSavedHint(`已保存：标题「${result.title}」`);
    },
    onError: (err) => {
      setSavedHint(null);
      if (err instanceof ApiError && err.code === "LINT_ERROR") {
        setServerIssues(parseApiIssues(err.extra));
        setServerError(err.message);
        return;
      }
      setServerIssues(null);
      setServerError(
        err instanceof Error ? err.message : "保存失败，请稍后重试",
      );
    },
  });

  const displayedIssues = serverIssues ?? check?.issues ?? [];
  const diagnostics = useMemo(
    () => lintIssuesToDiagnostics(displayedIssues, text),
    [displayedIssues, text],
  );

  const canSave = check !== null && !check.hasError && !saveMutation.isPending;

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PencilLine aria-hidden className="size-4 text-muted-foreground" />
            编辑讲义
          </SheetTitle>
          <SheetDescription className="text-xs">
            {detailQuery.data?.title ?? lectureId}
            {check?.title !== undefined &&
            check.title !== detailQuery.data?.title
              ? ` → 保存后标题变为「${check.title}」`
              : ""}
          </SheetDescription>
        </SheetHeader>

        {detailQuery.isPending ? <SheetLoading /> : null}
        {detailQuery.isError ? (
          <SheetError
            message={
              detailQuery.error instanceof Error
                ? detailQuery.error.message
                : "加载失败"
            }
            onRetry={() => void detailQuery.refetch()}
          />
        ) : null}

        {detailQuery.data !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
              <div className="flex min-h-0 flex-col overflow-hidden lg:border-r lg:border-border">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  讲义原文（整篇 Markdown，首个 H1 为标题）
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <MarkdownEditor
                    value={text}
                    onChange={(value) => {
                      setText(value);
                      setTextTouched(true);
                      // 再次编辑后：成功提示与服务端 422 回显失效，改看本地实时 lint
                      setSavedHint(null);
                      setServerIssues(null);
                      setServerError(null);
                    }}
                    diagnostics={diagnostics}
                  />
                </div>
              </div>
              <div className="flex min-h-0 flex-col overflow-hidden">
                <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  渲染预览
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="mx-auto max-w-2xl">
                    <RichMarkdown
                      source={check?.wrapped ?? wrapLectureMd(text)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {serverError !== null ? (
              <p
                role="alert"
                className="flex items-start gap-2 border-t border-border bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {serverError}
              </p>
            ) : null}
            {displayedIssues.length > 0 ? (
              <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border">
                <ErrorPanel
                  path={filenameOf("讲义", lectureId)}
                  markdown={text}
                  issues={displayedIssues}
                />
              </div>
            ) : null}

            <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-4 py-3">
              <Button
                type="button"
                className="min-h-11 px-5"
                disabled={!canSave}
                onClick={() => {
                  setServerError(null);
                  setServerIssues(null);
                  saveMutation.mutate();
                }}
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    保存中…
                  </>
                ) : (
                  <>
                    <Save aria-hidden />
                    保存
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={onClose}
                disabled={saveMutation.isPending}
              >
                关闭
              </Button>
              {/* T2B.7：发布到共享目录（D16 快照；服务端按已保存内容导出，未保存的
                  编辑不进快照——确认弹层有说明） */}
              {detailQuery.data !== undefined ? (
                <PublishConfirmDialog
                  kind="lecture"
                  id={lectureId}
                  title={detailQuery.data.title}
                />
              ) : null}
              {savedHint !== null ? (
                <p
                  role="status"
                  className="text-sm text-emerald-600 dark:text-emerald-400"
                >
                  {savedHint}
                </p>
              ) : null}
              {check?.hasError ? (
                <p className="text-sm text-destructive" role="alert">
                  存在错误或 H1 数量不符，修正后才能保存。
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ---------- 抽屉内的加载/错误态 ----------

function SheetLoading() {
  return (
    <div
      aria-live="polite"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-muted-foreground"
    >
      <Loader2 aria-hidden className="size-6 animate-spin" />
      <p className="text-sm">正在加载原文…</p>
    </div>
  );
}

function SheetError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <CircleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">原文加载失败</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
