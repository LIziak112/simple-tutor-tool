/**
 * 笔迹几何共享原语（T6R.6 自 render-note/erase 收敛上提）：
 * 单笔包围盒（逻辑坐标）带可选外扩 pad——erase 的命中粗筛是 pad=0 特例
 * （外扩量由调用方按橡皮半径+半线宽自行加），渲染器的「包围盒含线宽」
 * 是 pad=weight/2 特例。一份实现，两处共用。
 */
import type { InkStroke } from "./types.ts";

/** 单笔包围盒（逻辑坐标；四向已含 pad） */
export interface StrokeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 单笔包围盒（逻辑坐标）。pad 向四向外扩（如 weight/2）；空笔画返回 null。
 * 注：min(pt)-pad 与 min(pt-pad) 等值（pad 在一笔内恒定），与历史逐点
 * 折叠实现逐位一致。
 */
export function strokeBounds(stroke: InkStroke, pad = 0): StrokeBounds | null {
  if (stroke.points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of stroke.points) {
    if (pt.x - pad < minX) minX = pt.x - pad;
    if (pt.y - pad < minY) minY = pt.y - pad;
    if (pt.x + pad > maxX) maxX = pt.x + pad;
    if (pt.y + pad > maxY) maxY = pt.y + pad;
  }
  return { minX, minY, maxX, maxY };
}
