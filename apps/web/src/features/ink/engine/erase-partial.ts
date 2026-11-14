/**
 * 局部橡皮：把一笔里被橡皮扫过的部分切掉，留下的各段各成一笔。
 *
 * 橡皮扫过的区域是「上一个落点到这一个落点的线段」外扩一圈；够得着的距离与
 * 整笔橡皮同口径（橡皮半径 + 半笔宽，见 erase.ts 的 strokeHit）——这样切口处
 * 圆头收笔的那半个笔宽刚好退到橡皮圈外，圈里不留墨。切口落在采样点之间时按
 * 比例插值出新的端点（坐标、压感、时间），图形这类采样稀的笔画也切得准。
 *
 * 切出来的段沿用原笔画的工具、颜色、线宽与渲染参数；段内时间从 0 重新起算，
 * 落笔时刻顺延到这一段在原笔画里开始的时刻（回放时各段仍按原来的先后与节奏
 * 出现）。段不带 id，由提交的一方铸造；各段带上原笔的 id 作记号（cutFrom，
 * 原笔自己也是切出来的就沿用它的记号），绘制时据此把同一笔的荧光笔各段合在
 * 一起上一次色（paint-runs.ts）。纯函数，不碰 DOM。
 */
import type { StrokeBounds } from "./bounds.ts";
import type { InkStroke, InkStrokePoint } from "./types.ts";

type XY = Pick<InkStrokePoint, "x" | "y">;
type Interval = readonly [number, number];

/** 切剩的一截至少这么长（坐标单位）才留下；另见 minPieceLength */
const MIN_PIECE_LENGTH = 0.5;

/** 接触长度小于这个数（坐标单位）当作没碰到：擦着边不切 */
const TOUCH_EPSILON = 1e-6;

/** 一笔画出来的线宽（自然笔感按配置的倍率放大，与 strokeHit、strokeBounds 同口径） */
function paintedWidth(stroke: InkStroke): number {
  const scale =
    stroke.rendering?.renderer === "freehand" ? stroke.rendering.sizeScale : 1;
  return stroke.weight * scale;
}

/** 橡皮够得着这一笔中线的距离：橡皮半径 + 半笔宽 */
export function eraseReach(stroke: InkStroke, radius: number): number {
  return radius + paintedWidth(stroke) / 2;
}

/** 比半笔宽还短的一截画出来只是个墨点，不留 */
function minPieceLength(stroke: InkStroke): number {
  return Math.max(MIN_PIECE_LENGTH, paintedWidth(stroke) / 2);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** lo ≤ c0 + u·c1 ≤ hi 在 u 上的解区间（c1 为 0 时要么全体要么无解） */
function linearRange(
  c0: number,
  c1: number,
  lo: number,
  hi: number,
): Interval | null {
  if (c1 === 0) {
    return c0 >= lo && c0 <= hi
      ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
      : null;
  }
  const u0 = (lo - c0) / c1;
  const u1 = (hi - c0) / c1;
  return u0 <= u1 ? [u0, u1] : [u1, u0];
}

/** 线段 a→b 落在以 c 为心、reach 为半径的圆里的参数区间 */
function insideDisc(a: XY, b: XY, c: XY, reach: number): Interval | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const qa = dx * dx + dy * dy;
  const qc = fx * fx + fy * fy - reach * reach;
  if (qa === 0) {
    return qc <= 0 ? [0, 1] : null;
  }
  const qb = 2 * (fx * dx + fy * dy);
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
}

/** 线段 a→b 落在「from→to 两侧各 reach 宽的长条」里的参数区间 */
function insideBand(
  a: XY,
  b: XY,
  from: XY,
  to: XY,
  reach: number,
): Interval | null {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const length = Math.hypot(ex, ey);
  if (length === 0) return null;
  const ux = ex / length;
  const uy = ey / length;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - from.x;
  const fy = a.y - from.y;
  const along = linearRange(fx * ux + fy * uy, dx * ux + dy * uy, 0, length);
  const across = linearRange(
    fy * ux - fx * uy,
    dy * ux - dx * uy,
    -reach,
    reach,
  );
  if (along === null || across === null) return null;
  const lo = Math.max(along[0], across[0]);
  const hi = Math.min(along[1], across[1]);
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 线段 a→b 被橡皮扫过（from→to 外扩 reach）的参数区间，限制在 [0,1]；没碰到
 * 返回 null。扫过的区域是凸的，线段落在里面的部分必是连续一段，所以把两端
 * 圆与中间长条各自的区间取并（最小下界到最大上界）就是答案。
 */
function coveredRange(
  a: XY,
  b: XY,
  from: XY,
  to: XY,
  reach: number,
): Interval | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const parts = [
    insideDisc(a, b, to, reach),
    from.x === to.x && from.y === to.y ? null : insideDisc(a, b, from, reach),
    insideBand(a, b, from, to, reach),
  ];
  for (const part of parts) {
    if (part === null) continue;
    const start = Math.max(0, part[0]);
    const end = Math.min(1, part[1]);
    if (start > end) continue;
    if (start < lo) lo = start;
    if (end > hi) hi = end;
  }
  if (lo > hi) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  // 零长度线段（重复采样点）只可能整个在里面；其余按接触长度判断是否擦着边
  if (length > 0 && (hi - lo) * length < TOUCH_EPSILON) return null;
  return [lo, hi];
}

/** a→b 上参数 u 处的点：坐标两位小数（与落库精度一致），压感、时间按比例 */
function pointAt(
  a: InkStrokePoint,
  b: InkStrokePoint,
  u: number,
): InkStrokePoint {
  return {
    x: round(a.x + (b.x - a.x) * u, 2),
    y: round(a.y + (b.y - a.y) * u, 2),
    p: round(a.p + (b.p - a.p) * u, 4),
    t: a.t + (b.t - a.t) * u,
  };
}

function pathLength(points: readonly InkStrokePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (prev && next) total += Math.hypot(next.x - prev.x, next.y - prev.y);
  }
  return total;
}

/**
 * 一截点序列 → 一笔：时间从 0 重新起算，落笔时刻顺延，记下出自哪一笔；太短
 * 的碎屑返回 null。原笔没有 id 也没有记号时这里不带记号（擦除会话会补）。
 */
function toPiece(
  stroke: InkStroke,
  points: InkStrokePoint[],
): InkStroke | null {
  const first = points[0];
  if (first === undefined || points.length < 2) return null;
  if (pathLength(points) < minPieceLength(stroke)) return null;
  const offset = Math.round(first.t);
  const { id, startedAt, ...rest } = stroke;
  const cutFrom = stroke.cutFrom ?? id;
  return {
    ...rest,
    ...(cutFrom === undefined ? {} : { cutFrom }),
    ...(startedAt === undefined ? {} : { startedAt: startedAt + offset }),
    points: points.map((point) => ({
      ...point,
      t: Math.max(0, Math.round(point.t) - offset),
    })),
  };
}

/**
 * 橡皮从 from 划到 to（from 缺省为原地点一下）时，这一笔剩下的各段。
 * 没碰到返回 null——调用方据此保留原笔画对象（id 不变）；整笔都被擦掉返回 []。
 * bounds 可注入预先算好的未外扩包围盒（拖动中每笔只算一次）。
 */
export function splitStrokeByEraser(
  stroke: InkStroke,
  to: XY,
  radius: number,
  from: XY = to,
  bounds?: StrokeBounds | null,
): InkStroke[] | null {
  const { points } = stroke;
  const first = points[0];
  if (first === undefined) return null;
  const reach = eraseReach(stroke, radius);
  if (
    bounds &&
    (Math.max(to.x, from.x) < bounds.minX - reach ||
      Math.min(to.x, from.x) > bounds.maxX + reach ||
      Math.max(to.y, from.y) < bounds.minY - reach ||
      Math.min(to.y, from.y) > bounds.maxY + reach)
  ) {
    return null;
  }
  if (points.length === 1) {
    return coveredRange(first, first, from, to, reach) === null ? null : [];
  }

  const pieces: InkStroke[] = [];
  let current: InkStrokePoint[] = [];
  let touched = false;
  const closePiece = () => {
    const piece = toPiece(stroke, current);
    if (piece) pieces.push(piece);
    current = [];
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const covered = coveredRange(a, b, from, to, reach);
    if (covered === null) {
      if (current.length === 0) current.push(a);
      current.push(b);
      continue;
    }
    touched = true;
    const [start, end] = covered;
    if (start > 0) {
      if (current.length === 0) current.push(a);
      current.push(pointAt(a, b, start));
    }
    closePiece();
    if (end < 1) current = [pointAt(a, b, end), b];
  }
  if (!touched) return null;
  closePiece();
  return pieces;
}
