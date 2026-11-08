/**
 * 标注回看视图（T6R.20，学生结果页/教师作答详情页共用）：
 * - 折叠入口（打开才拉取——整卷逐题不产生 N 个请求）；
 * - stale=true 显示「旧版本题干的标注」（题目改版后旧圈仍锚定旧底图）；
 * - sealed 显示「已随交卷固定」；doc=null 显示「未圈画」空态；
 * - 底图缺失（base 非 ready/丢失）显式「底图缺失」态——**拒绝导出合成图**
 *   （绝不导出孤立的圈）；
 * - 导出合成图＝canvas 直绘（drawImage 底图＋笔迹层单 PNG，不走
 *   html-to-image——见 annotation-composite）。
 */
import type {
  AnnotationPhase,
  AnnotationViewData,
  AttemptQuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import {
  ChevronDown,
  CircleAlert,
  ClipboardCopy,
  History,
  ImageDown,
  LoaderCircle,
  Lock,
  PenLine,
  TriangleAlert,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  fetchAnnotationViewApi,
  fetchTeacherAnnotationViewApi,
  saveBlobAs,
} from "@/lib/api";
import { copyPngBlobToClipboard } from "@/lib/copy";
import { AnnotationStaticCanvas } from "./AnnotationStaticCanvas";
import {
  annotationCompositeFilename,
  exportAnnotationComposite,
} from "./annotation-composite";
import {
  QuestionAnnotationFrame,
  type QuestionFrameGeometry,
  questionFrameIdentity,
} from "./QuestionAnnotationFrame";
import { resolveQuestionSurface } from "./question-surface-resolver";
import { useAnnotationSessionRef } from "./use-annotation-record";

type ViewPhase = "idle" | "loading" | "loaded" | "error";

export interface AnnotationViewProps {
  /** 题面原位回看：进入可见区域自动读取，成功后在同一位置呈现原稿。 */
  children?: ReactNode;
  /** 主题面原位回看；children 仅为缺少历史公开模型时的可读内容。 */
  inline?: boolean;
  question?: AttemptQuestionPublic | undefined;
  answer?: StudentAnswer | undefined;
  correctOptionIndexes?: readonly number[] | undefined;
  /** 结果页闭合入口并排，展开材料仍占满可用宽度。 */
  compact?: boolean;
  viewer: "student" | "teacher";
  attemptId: string;
  questionId: string;
  phase?: AnnotationPhase;
  /** 卷内题号（合成图文件名用；缺省 0 只影响文件名） */
  questionNo?: number;
  ariaPrefix?: string;
}

export function AnnotationView(props: AnnotationViewProps) {
  const session = useAnnotationSessionRef();
  const scopeKey = JSON.stringify([
    window.location.origin,
    props.viewer,
    props.viewer === "student" ? session?.studentId : null,
    props.attemptId,
    props.questionId,
    props.phase ?? "scratch",
    props.question?.questionRevisionId,
  ]);
  return (
    <AnnotationViewContent key={scopeKey} {...props} scopeKey={scopeKey} />
  );
}

function NativeQuestionReview({
  question,
  questionId,
  answer,
  correctOptionIndexes,
  view,
  scopeKey,
  children,
}: {
  question?: AttemptQuestionPublic | undefined;
  questionId: string;
  answer?: StudentAnswer | undefined;
  correctOptionIndexes?: readonly number[] | undefined;
  view: AnnotationViewData | null;
  scopeKey: string;
  children?: ReactNode;
}) {
  const [geometry, setGeometry] = useState<QuestionFrameGeometry | null>(null);
  const [retry, setRetry] = useState(0);
  const resolution =
    question && view?.doc
      ? resolveQuestionSurface(
          {
            base: view.base,
            doc: view.doc,
            localBase: null,
            sealedAt: view.annotation?.sealedAt ?? null,
            conflict: null,
            retained: null,
          },
          question.questionRevisionId,
          true,
        )
      : null;
  const source = resolution?.status === "blocked" ? null : resolution?.source;
  const frameScope = JSON.stringify([scopeKey, view?.resetVersion ?? 0, retry]);
  const identity = question
    ? questionFrameIdentity(question, source?.layout ?? null, frameScope)
    : null;
  const sameGeometry = geometry?.identity === identity;
  const showInk =
    source &&
    sameGeometry &&
    (geometry.status === "ready" || geometry.preserveInk === true);
  const problem =
    view?.doc && !question
      ? "缺少公开冻结题面信息，原稿已保留，暂不能核验笔迹位置"
      : question && question.id !== questionId
        ? "原稿与当前题目身份不符，原记录已保留"
        : resolution?.status === "blocked"
          ? resolution.reason
          : sameGeometry && geometry.status === "blocked"
            ? geometry.reason
            : null;
  return (
    <>
      {question ? (
        <QuestionAnnotationFrame
          question={question}
          layout={source?.layout ?? null}
          scopeKey={frameScope}
          onGeometryChange={setGeometry}
          inkLayer={
            showInk && view?.doc && question?.id === questionId ? (
              <AnnotationStaticCanvas
                doc={view.doc}
                base={{
                  pixelWidth: source.pixelWidth,
                  pixelHeight: source.pixelHeight,
                }}
                ready
              />
            ) : undefined
          }
        >
          <QuestionSurface
            question={question}
            answer={answer}
            readOnly
            correctOptionIndexes={correctOptionIndexes}
          />
        </QuestionAnnotationFrame>
      ) : (
        children
      )}
      {problem && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 text-sm text-destructive"
        >
          {problem}
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新加载标画
          </Button>
        </div>
      )}
    </>
  );
}

function AnnotationViewContent({
  viewer,
  attemptId,
  questionId,
  phase = "scratch",
  questionNo = 0,
  ariaPrefix = "本题",
  compact = false,
  children,
  question,
  answer,
  correctOptionIndexes,
  inline: inlineProp = false,
  scopeKey,
}: AnnotationViewProps & { scopeKey: string }) {
  const inline = inlineProp || children !== undefined;
  const container = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const [open, setOpen] = useState(false);
  const [phaseState, setPhaseState] = useState<ViewPhase>("idle");
  const [view, setView] = useState<AnnotationViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  /** 最近一次成功导出的合成图 Blob（「复制图片」辅助出口用，审查修复 14） */
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unsupported">(
    "idle",
  );
  const label = `${ariaPrefix}题干标注`;

  useEffect(() => {
    if (!inline || !container.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setOpen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setOpen(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [inline]);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setPhaseState("loading");
    setError(null);
    try {
      const data =
        viewer === "teacher"
          ? await fetchTeacherAnnotationViewApi(attemptId, questionId, phase)
          : await fetchAnnotationViewApi(attemptId, questionId, phase);
      if (generation !== loadGeneration.current) return;
      setView(data);
      setPhaseState("loaded");
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setError(err instanceof Error ? err.message : "加载失败");
      setPhaseState("error");
    }
  }, [viewer, attemptId, questionId, phase]);

  useEffect(() => {
    if (open && phaseState === "idle") void load();
  }, [open, phaseState, load]);

  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    [],
  );

  const baseReady =
    view?.base !== null &&
    view?.base !== undefined &&
    view.base.state === "ready" &&
    view.base.pixelWidth !== null;
  const strokeCount = view?.doc?.strokes.length ?? 0;

  const handleExport = useCallback(async (): Promise<void> => {
    if (view === null || view.base === null || view.doc === null) return;
    setExporting(true);
    setExportResult(null);
    setCopyState("idle");
    const generation = loadGeneration.current;
    const result = await exportAnnotationComposite(view.base, view.doc);
    if (generation !== loadGeneration.current) return;
    setExporting(false);
    if (result.ok) {
      saveBlobAs(result.blob, annotationCompositeFilename(questionNo, phase));
      setExportedBlob(result.blob);
      setExportResult("已导出合成图（底图＋标注一图）");
    } else {
      setExportedBlob(null);
      setExportResult(result.error.message);
    }
  }, [view, questionNo, phase]);

  /** 复制合成图（审查修复 14：与 ExportReviewImageSection 同降级口径） */
  const handleCopyImage = useCallback(async (): Promise<void> => {
    if (exportedBlob === null) return;
    const ok = await copyPngBlobToClipboard(exportedBlob);
    setCopyState(ok ? "copied" : "unsupported");
  }, [exportedBlob]);

  if (inline) {
    return (
      <div
        ref={container}
        data-slot="annotation-question-view"
        className="min-w-0"
      >
        <NativeQuestionReview
          question={question}
          questionId={questionId}
          answer={answer}
          correctOptionIndexes={correctOptionIndexes}
          view={view}
          scopeKey={scopeKey}
        >
          {children}
        </NativeQuestionReview>
        {view?.base?.stale && <p role="note">旧版本题干的标注</p>}
        {view?.annotation?.sealedAt && <p>已随交卷固定</p>}
        {phaseState === "error" && (
          <div
            role="alert"
            className="mt-2 flex items-center gap-2 text-sm text-destructive"
          >
            {error}
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void load()}
            >
              重新加载标画
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-slot="annotation-view"
      className={`flex min-w-0 flex-col gap-2 ${compact ? (open ? "w-full" : "w-fit") : ""}`}
    >
      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 gap-1.5"
          onClick={() => setOpen(true)}
          aria-label={`查看${label}`}
        >
          <PenLine aria-hidden className="size-4" />
          题干标注
          <ChevronDown aria-hidden className="size-4" />
        </Button>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <PenLine aria-hidden className="size-4" />
            题干标注
            {strokeCount > 0 && (
              <span className="font-normal text-muted-foreground">
                {strokeCount} 笔
              </span>
            )}
            {phase === "correction" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                订正
              </span>
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1 px-2.5"
            onClick={() => setOpen(false)}
            aria-label={`收起${label}`}
          >
            <ChevronDown aria-hidden className="size-4" />
            收起
          </Button>
        </div>
      )}

      {open && (
        <>
          {phaseState === "loading" && (
            <div
              role="status"
              className="flex min-h-16 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在加载题干标注…
            </div>
          )}
          {phaseState === "error" && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
            >
              <p className="text-destructive">题干标注加载失败：{error}</p>
              <Button
                variant="outline"
                className="h-10 px-3 text-xs"
                onClick={() => void load()}
              >
                重试
              </Button>
            </div>
          )}
          {phaseState === "loaded" && view !== null && (
            <div className="flex flex-col gap-2">
              {/* 旧版标记：题目改版后的旧圈仍锚定旧底图（不重排字） */}
              {view.base?.stale === true && (
                <p
                  role="note"
                  className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  <History aria-hidden className="size-3.5 shrink-0" />
                  旧版本题干的标注（题目已改版，圈画仍固定在当时的题面上）
                </p>
              )}
              {/* 封存标记：交卷/订正检查点后只读 */}
              {view.annotation?.sealedAt != null && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock aria-hidden className="size-3.5" />
                  {phase === "correction"
                    ? "已随订正保存固定"
                    : "已随交卷固定（订正期另开新标注）"}
                </p>
              )}
              {(view.doc === null || !baseReady) && (
                <NativeQuestionReview
                  question={question}
                  questionId={questionId}
                  answer={answer}
                  view={view}
                  scopeKey={scopeKey}
                />
              )}
              {/* 空态：从未圈画 */}
              {view.doc === null && (
                <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
                  {view.base === null
                    ? "本题未使用题干标注"
                    : "已生成题干底图，但未圈画"}
                </p>
              )}
              {/* 底图缺失：显式状态，拒绝导出合成 */}
              {view.doc !== null && !baseReady && (
                <div
                  role="alert"
                  className="flex flex-col gap-1 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  <p className="flex items-center gap-1.5">
                    <TriangleAlert aria-hidden className="size-4 shrink-0" />
                    底图缺失：笔迹保留 {view.doc.strokes.length} 笔，但无法显示
                    底图与导出合成图（不会只导出孤立的圈）
                  </p>
                </div>
              )}
              {/* 正常态：底图 + 静态笔迹层 */}
              {view.doc !== null && baseReady && view.base !== null && (
                <>
                  <NativeQuestionReview
                    question={question}
                    questionId={questionId}
                    answer={answer}
                    view={view}
                    scopeKey={scopeKey}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={exporting}
                      onClick={() => void handleExport()}
                    >
                      {exporting ? (
                        <LoaderCircle
                          aria-hidden
                          className="size-4 animate-spin"
                        />
                      ) : (
                        <ImageDown aria-hidden className="size-4" />
                      )}
                      {exporting ? "正在导出…" : "导出合成图（PNG）"}
                    </Button>
                    {exportedBlob !== null && (
                      <Button
                        variant="outline"
                        className="h-11 min-h-11 px-3"
                        onClick={() => void handleCopyImage()}
                      >
                        <ClipboardCopy aria-hidden className="size-4" />
                        复制图片
                      </Button>
                    )}
                  </div>
                  {copyState === "copied" && (
                    <p className="text-sm text-muted-foreground">
                      已复制图片（可直接粘贴给 AI 或保存）。
                    </p>
                  )}
                  {copyState === "unsupported" && (
                    <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                      <CircleAlert aria-hidden className="size-4 shrink-0" />
                      当前环境不支持复制图片（常见于 HTTP 部署）——请使用已下载
                      的 PNG 文件，直接作为附件上传给 AI。
                    </p>
                  )}
                  {exportResult !== null && (
                    <p
                      role={
                        exportResult.startsWith("已导出") ? "status" : "alert"
                      }
                      className={
                        exportResult.startsWith("已导出")
                          ? "text-sm text-muted-foreground"
                          : "flex items-center gap-1.5 text-sm text-destructive"
                      }
                    >
                      {!exportResult.startsWith("已导出") && (
                        <CircleAlert aria-hidden className="size-4 shrink-0" />
                      )}
                      {exportResult}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
