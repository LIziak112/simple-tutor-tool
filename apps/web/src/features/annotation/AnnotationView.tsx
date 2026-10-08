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
  AnnotationDoc,
  AnnotationPhase,
  AnnotationViewData,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter.ts";
import {
  fetchAnnotationViewApi,
  fetchTeacherAnnotationViewApi,
  saveBlobAs,
} from "@/lib/api";
import { copyPngBlobToClipboard } from "@/lib/copy";
import {
  annotationCompositeFilename,
  exportAnnotationComposite,
} from "./annotation-composite";
import { replayAnnotationStroke } from "./annotation-surface";

type ViewPhase = "idle" | "loading" | "loaded" | "error";

/**
 * 静态笔迹层：底图 img 上方的只读 canvas（backing=底图像素域，CSS 同盒缩放）。
 *
 * 回放比例（审查修复 P0-1）：canvas 的 CSS 盒=底图显示宽≠位图域——atrament
 * 内部按 canvas.width/offsetWidth 再放大，重放必须以 cssPerBase=显示宽/位图宽
 * 换算坐标与线宽（与 annotation-surface redraw 的 scale=cssW/baseWidth 同口径）。
 * 布局就绪门控：等底图 img load 后才重放（img 未加载时容器 offsetHeight=0，
 * atrament 的 y 换算会产出 Infinity/NaN——审查次生缺陷）。effect 依赖收窄到
 * doc/base 字段与就绪标志（Q-L6：导出等 UI 状态刷新不得触发重放）。
 */
function AnnotationStaticCanvas({
  doc,
  base,
  baseLoaded,
}: {
  doc: AnnotationDoc;
  base: NonNullable<AnnotationViewData["base"]>;
  /** 底图 img 已加载（布局就绪信号——父组件 img onLoad 驱动） */
  baseLoaded: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!baseLoaded) return;
    const canvas = canvasRef.current;
    if (
      canvas === null ||
      base.pixelWidth === null ||
      base.pixelHeight === null
    ) {
      return;
    }
    // 布局就绪防御：量不到正尺寸（隐藏/未布局）不重放，等下一次就绪信号
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    canvas.width = base.pixelWidth;
    canvas.height = base.pixelHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const cssPerBase = rect.width / base.pixelWidth;
    let atrament = null;
    try {
      atrament = createProgrammaticAtrament(canvas);
      for (const stroke of doc.strokes) {
        replayAnnotationStroke(atrament, cssPerBase, stroke);
      }
    } finally {
      atrament?.destroy();
    }
  }, [baseLoaded, doc, base]);
  return (
    <canvas
      ref={canvasRef}
      data-slot="annotation-static-canvas"
      className="pointer-events-none absolute inset-0 block h-full w-full"
      aria-hidden
    />
  );
}

export interface AnnotationViewProps {
  viewer: "student" | "teacher";
  attemptId: string;
  questionId: string;
  phase?: AnnotationPhase;
  /** 卷内题号（合成图文件名用；缺省 0 只影响文件名） */
  questionNo?: number;
  ariaPrefix?: string;
}

export function AnnotationView({
  viewer,
  attemptId,
  questionId,
  phase = "scratch",
  questionNo = 0,
  ariaPrefix = "本题",
}: AnnotationViewProps) {
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
  /** 底图 img 布局就绪信号（回放门控；换底图/重载视图时复位——P0-1） */
  const [baseLoaded, setBaseLoaded] = useState(false);
  const baseId = view?.base?.baseId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies(baseId): baseId 是身份变更键（effect 体内不读取——换底图时复位就绪信号）
  useEffect(() => {
    setBaseLoaded(false);
  }, [baseId]);
  const label = `${ariaPrefix}题干标注`;

  const load = useCallback(async (): Promise<void> => {
    setPhaseState("loading");
    setError(null);
    try {
      const data =
        viewer === "teacher"
          ? await fetchTeacherAnnotationViewApi(attemptId, questionId, phase)
          : await fetchAnnotationViewApi(attemptId, questionId, phase);
      setView(data);
      setPhaseState("loaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setPhaseState("error");
    }
  }, [viewer, attemptId, questionId, phase]);

  useEffect(() => {
    if (open && phaseState === "idle") void load();
  }, [open, phaseState, load]);

  // 切换 phase/题目/角色（load 身份变化；教师卡 phase 切换——审查修复 3②）：
  // 重置回拉取态，由上面的打开效应重新拉取（初始 mount 为幂等 no-op）
  // biome-ignore lint/correctness/useExhaustiveDependencies(load): load 是身份变更键（effect 体内不读取）
  useEffect(() => {
    setPhaseState((prev) => (prev === "idle" ? prev : "idle"));
    setView(null);
    setExportResult(null);
  }, [load]);

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
    const result = await exportAnnotationComposite(view.base, view.doc);
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

  return (
    <div data-slot="annotation-view" className="flex min-w-0 flex-col gap-2">
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
                  <div className="relative w-full overflow-hidden rounded-lg border border-border bg-white">
                    <img
                      src={view.base.downloadUrl}
                      alt={`${label}底图`}
                      className="block w-full select-none"
                      draggable={false}
                      loading="lazy"
                      onLoad={() => setBaseLoaded(true)}
                    />
                    <AnnotationStaticCanvas
                      doc={view.doc}
                      base={view.base}
                      baseLoaded={baseLoaded}
                    />
                  </div>
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
