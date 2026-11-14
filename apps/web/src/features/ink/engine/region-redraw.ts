/**
 * 局部重画：只清空并重画画布上的一块矩形，其余像素原样留着。
 *
 * 局部橡皮拖动时几乎每一步都改到笔画；整张重画一页密集的草稿要把所有笔画
 * 逐段再描一遍，跟不上手。这里把改动限制在一块区域：矩形按位图像素向外
 * 取整（清空与裁剪都落在整像素上，边缘不留半透明的缝），矩形里按原来的先后
 * 顺序重画所有碰到它的笔画——该有的笔画一笔不少、不该有的一笔不留。
 *
 * 和整张重画相比，只可能差在跨过矩形边界的那几笔的边缘：浏览器给带裁剪的
 * 路径算抗锯齿时取样方式不同（Chromium 实测边缘像素的透明度最多差 43/255，
 * 肉眼看不出，也不会越画越多——每次都是先清空再画）。所以拖动结束时各书写面
 * 仍要整张重画一次，把画面归到同一种画法上（e2e/eraser-position.spec.ts 核对
 * 两者的差别只在这个量级）。
 */
import type { StrokeBounds } from "./bounds.ts";
import type { InkStroke } from "./types.ts";

/**
 * atrament 逐段描边时线宽会随运笔快慢加粗，最多比设定线宽多 30 CSS 像素
 * （见其 draw 的自适应线宽），即单侧 15；再留 1 像素给抗锯齿。算一笔画到
 * 哪儿、要不要跟着重画时，都按这个余量外扩，宁大勿小——小了会留下擦不掉的
 * 残墨，或把没重画的笔画挖出缺口。
 */
export const PAINT_SPREAD_CSS = 16;

/** 位图像素矩形（整数） */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function expandBounds(bounds: StrokeBounds, pad: number): StrokeBounds {
  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  };
}

/** 两个包围盒是否相交（贴边也算，宁可多画一笔） */
export function boundsOverlap(a: StrokeBounds, b: StrokeBounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

/**
 * 坐标域里的一块区域 → 位图像素矩形：向外取整并夹在画布内；整块在画布外
 * 返回 null。pixelsPerUnit 是一个坐标单位合多少位图像素。
 */
export function pixelRectOf(
  region: StrokeBounds,
  pixelsPerUnit: number,
  canvas: { width: number; height: number },
): PixelRect | null {
  if (!(pixelsPerUnit > 0)) return null;
  const x0 = Math.max(0, Math.floor(region.minX * pixelsPerUnit));
  const y0 = Math.max(0, Math.floor(region.minY * pixelsPerUnit));
  const x1 = Math.min(canvas.width, Math.ceil(region.maxX * pixelsPerUnit));
  const y1 = Math.min(canvas.height, Math.ceil(region.maxY * pixelsPerUnit));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 把重画限制在 rect 里：设裁剪区、清空、执行 paint，最后恢复画笔状态 */
export function repaintRect(
  context: CanvasRenderingContext2D,
  rect: PixelRect,
  paint: () => void,
): void {
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    context.clearRect(rect.x, rect.y, rect.width, rect.height);
    paint();
  } finally {
    context.restore();
  }
}

/** 往哪块画布上重画，以及坐标怎么换算 */
export interface RepaintTarget {
  context: CanvasRenderingContext2D;
  canvas: { width: number; height: number };
  /** 一个坐标单位合多少位图像素 */
  pixelsPerUnit: number;
  /** 画法在 paintBounds 之外还可能多画出去多少（坐标单位），见 PAINT_SPREAD_CSS */
  spread: number;
}

/**
 * 只重画 region 这一块：清空它（外扩 spread 后按像素取整），再把画得到这块
 * 的笔画按原顺序各画一遍（paint 画整笔，超出的部分被裁掉）。
 * 返回实际重画的像素矩形；region 整块在画布外时什么都不做，返回 null。
 */
export function repaintRegion<
  T extends { stroke: InkStroke; paintBounds: StrokeBounds | null },
>(
  target: RepaintTarget,
  region: StrokeBounds,
  strokes: readonly T[],
  paint: (item: T) => void,
): PixelRect | null {
  const { context, canvas, pixelsPerUnit, spread } = target;
  const rect = pixelRectOf(expandBounds(region, spread), pixelsPerUnit, canvas);
  if (rect === null) return null;
  // 取整后的矩形换回坐标单位；笔画范围外扩 spread 等价于把这块再外扩 spread
  const reach = expandBounds(
    {
      minX: rect.x / pixelsPerUnit,
      minY: rect.y / pixelsPerUnit,
      maxX: (rect.x + rect.width) / pixelsPerUnit,
      maxY: (rect.y + rect.height) / pixelsPerUnit,
    },
    spread,
  );
  repaintRect(context, rect, () => {
    for (const item of strokes) {
      if (item.paintBounds !== null && boundsOverlap(item.paintBounds, reach)) {
        paint(item);
      }
    }
  });
  return rect;
}
