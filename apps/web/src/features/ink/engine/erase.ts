/**
 * 整笔橡皮命中检测（T2.7，架构 §5.4.1 绘制层第 3 条）。
 *
 * "整笔橡皮"：橡皮轨迹点距离某笔任意一段小于半径，即删除**整笔**（而不是
 * 像素级擦除）——更适合答题场景且天然可撤销（一个 remove 历史条目）。
 * 全部使用逻辑坐标（宽度 1000 基准），半径也是逻辑单位。
 */
import { type StrokeBounds, strokeBounds } from "./bounds.ts";
import type { InkStroke, InkStrokePoint } from "./types.ts";

type ErasePoint = Pick<InkStrokePoint, "x" | "y">;

/** 两条线段的距离：相交为零，否则取端点到对方线段的最短距离。 */
function distSqBetweenSegments(
  a: ErasePoint,
  b: ErasePoint,
  c: ErasePoint,
  d: ErasePoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ex = d.x - c.x;
  const ey = d.y - c.y;
  const cross = dx * ey - dy * ex;
  if (cross !== 0) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    distSqToSegment(a.x, a.y, c.x, c.y, d.x, d.y),
    distSqToSegment(b.x, b.y, c.x, c.y, d.x, d.y),
    distSqToSegment(c.x, c.y, a.x, a.y, b.x, b.y),
    distSqToSegment(d.x, d.y, a.x, a.y, b.x, b.y),
  );
}

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
 * 一笔是否与橡皮扫过区域相交；半径内部计入半笔宽，from 缺省为单点。
 * bounds 可选注入预计算的未外扩包围盒（T6R.7 复审⑨：橡皮拖动的热路径每个
 * pointermove 只算一次逐笔盒，批内 coalesced 采样点共享；缺省现算）。
 */
export function strokeHit(
  stroke: InkStroke,
  x: number,
  y: number,
  radius: number,
  bounds?: StrokeBounds | null,
  from?: ErasePoint,
): boolean {
  if (stroke.points.length === 0) return false;
  // 粗筛：笔画包围盒外扩后与橡皮轨迹包围盒不相交则必不命中。
  const b = bounds ?? strokeBounds(stroke);
  if (b === null) return false;
  const scale =
    stroke.rendering?.renderer === "freehand" ? stroke.rendering.sizeScale : 1;
  const pad = radius + (stroke.weight * scale) / 2;
  const start = from ?? { x, y };
  const end = { x, y };
  if (
    Math.max(x, start.x) < b.minX - pad ||
    Math.min(x, start.x) > b.maxX + pad ||
    Math.max(y, start.y) < b.minY - pad ||
    Math.min(y, start.y) > b.maxY + pad
  ) {
    return false;
  }
  const rSq = pad * pad;
  const first = stroke.points[0];
  if (first === undefined) return false;
  let previous = first;
  // 单点笔画：按点到橡皮轨迹判定。
  if (stroke.points.length === 1) {
    return distSqToSegment(first.x, first.y, start.x, start.y, x, y) <= rSq;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const pt = stroke.points[i];
    if (pt === undefined) continue;
    const distance =
      start.x === x && start.y === y
        ? distSqToSegment(x, y, previous.x, previous.y, pt.x, pt.y)
        : distSqBetweenSegments(start, end, previous, pt);
    if (distance <= rSq) return true;
    previous = pt;
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
  from?: ErasePoint,
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (stroke && strokeHit(stroke, x, y, radius, boxes?.[i], from))
      hits.push(i);
  }
  return hits;
}
