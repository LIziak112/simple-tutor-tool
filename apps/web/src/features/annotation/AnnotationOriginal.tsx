import type { AnnotationBaseRef, AnnotationDoc } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter";
import { replayAnnotationStroke } from "./annotation-surface";

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
  base: Pick<AnnotationBaseRef, "pixelWidth" | "pixelHeight">;
  /** 底图 img 已加载（布局就绪信号——父组件 img onLoad 驱动） */
  baseLoaded: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sizeVersion, setSizeVersion] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !baseLoaded) return;
    const resize = new ResizeObserver(() =>
      setSizeVersion((value) => value + 1),
    );
    resize.observe(canvas);
    return () => resize.disconnect();
  }, [baseLoaded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 尺寸版本触发同一逻辑坐标稿的重绘
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
    } catch (error) {
      atrament?.destroy();
      throw error;
    }
    // destroy会清画布，只在静态回放卸载/重绘时执行，不能抹掉刚绘制的圈。
    return () => atrament?.destroy();
  }, [baseLoaded, doc, base.pixelWidth, base.pixelHeight, sizeVersion]);
  return (
    <canvas
      ref={canvasRef}
      data-slot="annotation-static-canvas"
      className="pointer-events-none absolute inset-0 block h-full w-full"
      aria-hidden
    />
  );
}

/** 原稿只依赖保存时的底图与矢量坐标，不核对当前设备的 DOM 排版。 */
export function AnnotationOriginal(props: {
  src: string;
  pixelWidth: number;
  pixelHeight: number;
  doc: AnnotationDoc;
  label: string;
  onReadyChange?: (ready: boolean) => void;
}) {
  // 换底图即卸载旧加载状态，迟到的图片事件不能让新底图提前就绪。
  return (
    <OriginalImage
      key={JSON.stringify([props.src, props.pixelWidth, props.pixelHeight])}
      {...props}
    />
  );
}

function OriginalImage({
  src,
  pixelWidth,
  pixelHeight,
  doc,
  label,
  onReadyChange,
}: Parameters<typeof AnnotationOriginal>[0]) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const matches =
    pixelWidth > 0 &&
    pixelHeight > 0 &&
    doc.baseWidth === pixelWidth &&
    doc.baseHeight === pixelHeight;
  if (!matches)
    return <p role="alert">底图与标画尺寸不匹配，原稿已保留，请重新加载材料</p>;
  return (
    <div data-slot="annotation-original" className="min-w-0">
      {!loaded && !error && (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          正在加载原圈画…
        </p>
      )}
      <div className="relative w-full" hidden={!loaded}>
        <img
          key={retry}
          src={src}
          alt={`${label}底图`}
          className="block h-auto w-full select-none"
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (
              image.naturalWidth !== pixelWidth ||
              image.naturalHeight !== pixelHeight
            ) {
              setError("底图与标画尺寸不匹配，原稿已保留");
              onReadyChange?.(false);
              return;
            }
            setError(null);
            setLoaded(true);
            onReadyChange?.(true);
          }}
          onError={() => {
            setLoaded(false);
            setError("原圈画底图加载失败，原稿已保留");
            onReadyChange?.(false);
          }}
        />
        <AnnotationStaticCanvas
          doc={doc}
          base={{ pixelWidth, pixelHeight }}
          baseLoaded={loaded}
        />
      </div>
      {error && (
        <div role="alert" className="space-y-2 py-2 text-sm text-destructive">
          <p>{error}</p>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => {
              setLoaded(false);
              setError(null);
              onReadyChange?.(false);
              setRetry((value) => value + 1);
            }}
          >
            重新加载原圈画
          </Button>
        </div>
      )}
    </div>
  );
}
