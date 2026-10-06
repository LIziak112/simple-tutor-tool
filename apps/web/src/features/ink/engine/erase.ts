/**
 * 整笔橡皮命中检测（T2.7，架构 §5.4.1 绘制层第 3 条）。
 *
 * "整笔橡皮"：橡皮轨迹点距离某笔任意一段小于半径，即删除**整笔**（而不是
 * 像素级擦除）——更适合答题场景且天然可撤销（一个 remove 历史条目）。
 * 全部使用逻辑坐标（宽度 1000 基准），半径也是逻辑单位。
 */
import { type StrokeBounds, strokeBounds } from "./bounds.ts";
import type { InkStroke } from "./types.ts";

/** 点到线段的最短距离平方（避免开方，与半径平方比较） */
function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // 退化为点
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  // 投影参数限制在 [0,1]（线段而非直线）
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * 一笔是否与检测圆相交（逻辑坐标；radius 为逻辑半径，需含笔宽的一半容差）。
 * bounds 可选注入预计算的未外扩包围盒（T6R.7 复审⑨：橡皮拖动的热路径每个
 * pointermove 只算一次逐笔盒，批内 coalesced 采样点共享；缺省现算）。
 */
export function strokeHit(
  stroke: InkStroke,
  x: number,
  y: number,
  radius: number,
  bounds?: StrokeBounds | null,
): boolean {
  if (stroke.points.length === 0) return false;
  // 粗筛：包围盒外扩 radius 后不含检测点则必不命中
  const b = bounds ?? strokeBounds(stroke);
  if (b === null) return false;
  const pad = radius + stroke.weight / 2;
  if (
    x < b.minX - pad ||
    x > b.maxX + pad ||
    y < b.minY - pad ||
    y > b.maxY + pad
  ) {
    return false;
  }
  const rSq = radius * radius;
  const first = stroke.points[0];
  if (first === undefined) return false;
  let prevX = first.x;
  let prevY = first.y;
  // 单点笔画：按点到点判定
  if (stroke.points.length === 1) {
    return distSqToSegment(x, y, prevX, prevY, prevX, prevY) <= rSq;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const pt = stroke.points[i];
    if (pt === undefined) continue;
    if (distSqToSegment(x, y, prevX, prevY, pt.x, pt.y) <= rSq) return true;
    prevX = pt.x;
    prevY = pt.y;
  }
  return false;
}

/**
 * 橡皮拖动一步：返回被命中的笔画下标（升序，通常 0 或 1 个）。
 * 调用方负责累积并在拖动结束时一次性 commitErase。
 * boxes 可选注入与 strokes 一一对应的预计算包围盒（复审⑨热路径）。
 */
export function eraseHit(
  strokes: readonly InkStroke[],
  x: number,
  y: number,
  radius: number,
  boxes?: Array<StrokeBounds | null>,
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (stroke && strokeHit(stroke, x, y, radius, boxes?.[i])) hits.push(i);
  }
  return hits;
}
