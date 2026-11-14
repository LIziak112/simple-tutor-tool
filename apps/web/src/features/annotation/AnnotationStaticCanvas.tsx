import type { AnnotationBaseRef, AnnotationDoc } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-replay";
import { replayAnnotationStroke } from "./annotation-surface";

/**
 * 静态笔迹层：真实题面同框的只读 canvas（backing=底图像素域，CSS 同盒缩放）。
 *
 * 回放比例（审查修复 P0-1）：canvas 的 CSS 盒=底图显示宽≠位图域——atrament
 * 内部按 canvas.width/offsetWidth 再放大，重放必须以 cssPerBase=显示宽/位图宽
 * 换算坐标与线宽（与 annotation-surface redraw 的 scale=cssW/baseWidth 同口径）。
 * 布局就绪门控：等宿主几何核验就绪后才重放（img 未加载时容器 offsetHeight=0，
 * atrament 的 y 换算会产出 Infinity/NaN——审查次生缺陷）。effect 依赖收窄到
 * doc/base 字段与就绪标志（Q-L6：导出等 UI 状态刷新不得触发重放）。
 */
export function AnnotationStaticCanvas({
  doc,
  base,
  ready,
}: {
  doc: AnnotationDoc;
  base: Pick<AnnotationBaseRef, "pixelWidth" | "pixelHeight">;
  /** 宿主逻辑几何已核验 */
  ready: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sizeVersion, setSizeVersion] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const resize = new ResizeObserver(() =>
      setSizeVersion((value) => value + 1),
    );
    resize.observe(canvas);
    return () => resize.disconnect();
  }, [ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 尺寸版本触发同一逻辑坐标稿的重绘
  useEffect(() => {
    if (!ready) return;
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
  }, [ready, doc, base.pixelWidth, base.pixelHeight, sizeVersion]);
  return (
    <canvas
      ref={canvasRef}
      data-slot="annotation-static-canvas"
      className="pointer-events-none absolute inset-0 block h-full w-full"
      aria-hidden
    />
  );
}
