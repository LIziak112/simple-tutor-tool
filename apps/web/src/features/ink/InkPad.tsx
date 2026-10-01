import {
  CircleAlert,
  Eraser,
  Hand,
  Highlighter,
  LoaderCircle,
  PenLine,
  Redo2,
  Trash,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  create,
  type InkChangeReason,
  type InkDoc,
  type InkEngine,
  type InkEngineKind,
  type InkPenColor,
  type InkPenSize,
  type InkToolType,
} from "./engine/index.ts";

/**
 * <InkPad>：手写引擎的 React 外壳（T2.7，架构 §5.4.1 "组件拆为两层"）。
 *
 * - 引擎与输入处理在 features/ink/engine（纯 TS）；本组件只负责工具栏、
 *   清空二次确认、自动加高、加载/错误态等 UI；
 * - 每笔结束（含撤销/重做/清空/load）经 onDocChange 上抛 InkDoc 与变化原因
 *   （reason，T4.0b ink_edit_batch 分型；缺省 "stroke"，老回调忽略零影响）；
 * - 自动加高（§5.4.1 绘制层第 4 条）：最后一笔接近答题区底部时自动增高；
 * - 工具栏触控目标不小于 44px（ui-conventions iPad 硬性要求）。
 */
export interface InkPadProps {
  /** 底层引擎：atrament（页内答题区，默认）/ excalidraw（全屏作答） */
  engine?: InkEngineKind;
  /** 恢复的笔迹（草稿）；exactOptionalPropertyTypes 下显式接受 undefined */
  initial?: InkDoc | undefined;
  /** atrament 初始高度（CSS 像素），写到底部自动加高 */
  initialHeight?: number;
  /** 填满父容器高度（全屏作答形态）：画布占满余下空间，禁用自动加高 */
  fill?: boolean;
  /** 无障碍标签 */
  label?: string;
  /** 每次笔迹变化回调（doc + 变化原因，T4.0b 起带 reason） */
  onDocChange?: ((doc: InkDoc, reason: InkChangeReason) => void) | undefined;
  /** 引擎实例透出（开发页/草稿保存等需要命令式访问 getData/load/exportPng） */
  engineRef?: React.RefObject<InkEngine | null> | undefined;
}

/** 自动加高：最后一笔距底部不足该值时加高一步 */
const GROW_THRESHOLD_PX = 72;
/** 每次加高的步长 */
const GROW_STEP_PX = 240;

/** 颜色按钮的色块（黑/蓝/红） */
const COLOR_SWATCH: Record<InkPenColor, string> = {
  black: "#1f2328",
  blue: "#1d4ed8",
  red: "#dc2626",
};

const COLOR_LABEL: Record<InkPenColor, string> = {
  black: "黑",
  blue: "蓝",
  red: "红",
};

const SIZE_LABEL: Record<InkPenSize, string> = {
  thin: "细",
  medium: "中",
  thick: "粗",
};

/** 工具按钮通用样式：高度 44px 起步（触控目标硬性尺寸） */
const toolButtonClass =
  "h-11 min-w-11 px-2.5 gap-1.5 rounded-lg border border-border text-sm font-medium select-none transition-colors";

export function InkPad({
  engine = "atrament",
  initial,
  initialHeight = 280,
  fill = false,
  label = "手写答题区",
  onDocChange,
  engineRef,
}: InkPadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 内部引擎实例引用（engineRef prop 为对外透出） */
  const localEngineRef = useRef<InkEngine | null>(null);
  /** onDocChange 用 ref 转发：父组件传内联函数时不触发引擎重建 */
  const onDocChangeRef = useRef(onDocChange);
  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  }, [onDocChange]);

  const [toolType, setToolType] = useState<InkToolType>("pen");
  const [penColor, setPenColor] = useState<InkPenColor>("black");
  const [penSize, setPenSize] = useState<InkPenSize>("medium");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  const [clearOpen, setClearOpen] = useState(false);
  const [ready, setReady] = useState(engine === "atrament");
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 懒加载失败后的重试键：重建引擎 */
  const [retryKey, setRetryKey] = useState(0);
  /** 草稿只在挂载时恢复一次：initial 经 ref 取值，引用变化不重建引擎 */
  const initialRef = useRef(initial);

  // 引擎创建/销毁（依赖 retryKey 重建）
  // biome-ignore lint/correctness/useExhaustiveDependencies(retryKey): 重试键仅用于强制重建引擎，effect 体内不读取
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let off: (() => void) | null = null;

    try {
      const initial = initialRef.current;
      const ink = create(container, {
        engine,
        ...(initial !== undefined ? { initial } : {}),
        ...(engine === "excalidraw"
          ? {
              onReady: () => {
                if (!disposed) setReady(true);
              },
              onError: (err: Error) => {
                if (!disposed)
                  setLoadError(err.message || "Excalidraw 加载失败");
              },
            }
          : {}),
      });
      localEngineRef.current = ink;
      if (engineRef) engineRef.current = ink;
      off = ink.on("change", (doc, reason) => {
        setCanUndo(ink.canUndo());
        setCanRedo(ink.canRedo());
        onDocChangeRef.current?.(doc, reason);
        // 自动加高：最后一笔的最低点接近底部时加高（仅 atrament 页内答题区）
        if (
          engine === "atrament" &&
          container.clientWidth > 0 &&
          doc.engine === "atrament"
        ) {
          // 泛型联合无法随 engine 字段收窄 data，校验后显式特化
          const strokes = (doc as InkDoc<"atrament">).data.strokes;
          const last = strokes[strokes.length - 1];
          if (last && last.points.length > 0) {
            const maxY = Math.max(...last.points.map((p) => p.y));
            const px = (maxY / 1000) * container.clientWidth;
            if (px > container.clientHeight - GROW_THRESHOLD_PX) {
              setHeight((h) => h + GROW_STEP_PX);
            }
          }
        }
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "手写引擎初始化失败");
    }

    return () => {
      disposed = true;
      off?.();
      localEngineRef.current?.destroy();
      localEngineRef.current = null;
      if (engineRef) engineRef.current = null;
    };
    // initial 经 initialRef 取值；engineRef 为父组件持有的稳定 ref 对象
  }, [engine, retryKey, engineRef]);

  // 工具/颜色/粗细变化 → 下发引擎
  useEffect(() => {
    const ink = localEngineRef.current;
    if (!ink) return;
    switch (toolType) {
      case "pen":
        ink.setTool({ type: "pen", color: penColor, size: penSize });
        break;
      case "highlighter":
        ink.setTool({ type: "highlighter" });
        break;
      case "eraser":
        ink.setTool({ type: "eraser" });
        break;
      case "scroll":
        ink.setTool({ type: "scroll" });
        break;
    }
    // excalidraw 未就绪时适配器内部排队，无需依赖 ready
  }, [toolType, penColor, penSize]);

  const handleUndo = useCallback(() => localEngineRef.current?.undo(), []);
  const handleRedo = useCallback(() => localEngineRef.current?.redo(), []);
  const handleClearConfirm = useCallback(() => {
    localEngineRef.current?.clear();
    setClearOpen(false);
  }, []);

  const toolsDisabled = !ready || loadError !== null;

  return (
    <div
      data-slot="ink-pad"
      className={`flex flex-col gap-2 [touch-action:manipulation] ${fill ? "h-full min-h-0" : ""}`}
    >
      {/* 工具栏：笔/荧光笔/橡皮/滚动（或套索）+ 颜色三选 + 粗细三档 + 撤销/重做/清空 */}
      <div
        role="toolbar"
        aria-label={`${label}工具栏`}
        className="flex flex-wrap items-center gap-1.5"
      >
        <Button
          type="button"
          variant={toolType === "pen" ? "secondary" : "ghost"}
          aria-pressed={toolType === "pen"}
          disabled={toolsDisabled}
          onClick={() => setToolType("pen")}
          className={`${toolButtonClass} h-11`}
          title="笔"
        >
          <PenLine aria-hidden />笔
        </Button>
        <Button
          type="button"
          variant={toolType === "highlighter" ? "secondary" : "ghost"}
          aria-pressed={toolType === "highlighter"}
          disabled={toolsDisabled}
          onClick={() => setToolType("highlighter")}
          className={`${toolButtonClass} h-11`}
          title="荧光笔"
        >
          <Highlighter aria-hidden />
          荧光笔
        </Button>
        <Button
          type="button"
          variant={toolType === "eraser" ? "secondary" : "ghost"}
          aria-pressed={toolType === "eraser"}
          disabled={toolsDisabled}
          onClick={() => setToolType("eraser")}
          className={`${toolButtonClass} h-11`}
          title="橡皮（整笔擦除）"
        >
          <Eraser aria-hidden />
          橡皮
        </Button>
        <Button
          type="button"
          variant={toolType === "scroll" ? "secondary" : "ghost"}
          aria-pressed={toolType === "scroll"}
          disabled={toolsDisabled}
          onClick={() => setToolType("scroll")}
          className={`${toolButtonClass} h-11`}
          title={
            engine === "atrament"
              ? "滚动模式（无笔设备：暂停书写，放行页面滚动）"
              : "选择/套索"
          }
        >
          <Hand aria-hidden />
          {engine === "atrament" ? "滚动" : "选择"}
        </Button>

        {/* 颜色三选（黑/蓝/红）；荧光笔固定黄色，禁用切换 */}
        {(toolType === "pen" || toolType === "highlighter") && (
          <div className="ml-1 flex items-center gap-1">
            {(Object.keys(COLOR_SWATCH) as InkPenColor[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色：${COLOR_LABEL[c]}`}
                aria-pressed={penColor === c}
                disabled={toolsDisabled || toolType === "highlighter"}
                onClick={() => setPenColor(c)}
                className={`flex size-11 items-center justify-center rounded-lg border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                  penColor === c && toolType === "pen"
                    ? "border-ring bg-muted"
                    : "border-transparent hover:bg-muted"
                }`}
              >
                <span
                  aria-hidden
                  className="size-5 rounded-full border border-black/10"
                  style={{ background: COLOR_SWATCH[c] }}
                />
              </button>
            ))}
          </div>
        )}
        {/* 粗细三档（细/中/粗） */}
        {toolType === "pen" && (
          <div className="flex items-center gap-1">
            {(Object.keys(SIZE_LABEL) as InkPenSize[]).map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`粗细：${SIZE_LABEL[s]}`}
                aria-pressed={penSize === s}
                disabled={toolsDisabled}
                onClick={() => setPenSize(s)}
                className={`flex size-11 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                  penSize === s
                    ? "border-ring bg-muted font-semibold"
                    : "border-transparent hover:bg-muted"
                }`}
              >
                <span
                  aria-hidden
                  className="rounded-full bg-foreground"
                  style={{
                    width: `${6 + (s === "thin" ? 0 : s === "medium" ? 4 : 8)}px`,
                    height: `${6 + (s === "thin" ? 0 : s === "medium" ? 4 : 8)}px`,
                  }}
                />
                {SIZE_LABEL[s]}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            disabled={!canUndo || loadError !== null}
            onClick={handleUndo}
            className={`${toolButtonClass} h-11`}
            title="撤销"
          >
            <Undo2 aria-hidden />
            撤销
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!canRedo || loadError !== null}
            onClick={handleRedo}
            className={`${toolButtonClass} h-11`}
            title="重做"
          >
            <Redo2 aria-hidden />
            重做
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="清空画布"
            disabled={toolsDisabled}
            onClick={() => setClearOpen(true)}
            className={`${toolButtonClass} h-11 text-destructive`}
            title="清空画布"
          >
            <Trash aria-hidden />
            清空
          </Button>
        </div>
      </div>

      {/* 画布容器：页内形态高度固定（自动加高）；全屏形态（fill）占满余下空间 */}
      <div
        ref={containerRef}
        data-slot="ink-pad-canvas"
        role="img"
        aria-label={label}
        style={fill ? undefined : { height: `${height}px` }}
        className={`relative w-full overflow-hidden rounded-xl border border-border bg-white ${fill ? "min-h-0 flex-1" : ""}`}
      >
        {/* Excalidraw 懒加载中 / 失败的覆盖层（三种状态，ui-conventions） */}
        {engine === "excalidraw" && !ready && !loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white text-sm text-muted-foreground">
            <LoaderCircle aria-hidden className="size-6 animate-spin" />
            手写引擎加载中…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center text-sm">
            <CircleAlert aria-hidden className="size-6 text-destructive" />
            <p>手写引擎加载失败：{loadError}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                setLoadError(null);
                setReady(false);
                setRetryKey((k) => k + 1);
              }}
            >
              重试
            </Button>
          </div>
        )}
      </div>

      {/* 清空二次确认（§5.4.1 绘制层第 3 条） */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空画布？</DialogTitle>
            <DialogDescription>
              将清除当前答题区的全部笔迹，清空后可用「撤销」恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setClearOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              onClick={handleClearConfirm}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
