/**
 * 图形工具（直线、箭头、矩形、椭圆）的点列。
 *
 * 图形落成一笔普通笔画，没有单独的「图形」数据：橡皮、撤销、回放、派生图、
 * 同步都按笔画处理，不用认识图形。这里只管由起止点算出这一笔的采样点：
 * - 骨架（shapeOutline）：按顺序连起来的顶点，拖动途中的预览画的就是它；
 * - 落库的点列（shapeStrokePoints）：沿骨架等距加密。atrament 逐段画一笔
 *   时，画到的位置比采样点落后一小段（平滑滤波）——点稀了拐角被削圆、线
 *   画不到头。等距的密点把这段落后压到看不出来，局部橡皮切出来的每一段也
 *   仍是一笔正常的笔画。硬拐角和终点各补一个重复点，让落后的那一小段追上
 *   来：拐角不被削圆，线画到头。粗细靠恒定压感保持一致（见 SHAPE_PRESSURE）。
 *
 * 尺寸常量按逻辑单位（宽 1000 的纸）定义。坐标单位不同的书写面（圈画用底图
 * 像素）传 unit——一个逻辑单位合多少坐标单位。纯函数，不碰 DOM。
 */
import type { InkShapeKind, InkStrokePoint } from "./types.ts";

export interface ShapeXY {
  x: number;
  y: number;
}

/** 图形的骨架 */
export interface ShapeOutline {
  /** 按顺序用直线连起来的顶点 */
  points: ShapeXY[];
  /** 顶点是不是硬拐角。椭圆不是：它的顶点只是把曲线分成小段 */
  cornered: boolean;
}

/** 相邻采样点的间距（逻辑单位） */
export const SHAPE_SPACING = 4;
/** 拖出的距离不到这么多（逻辑单位）不算一个图形，不落笔 */
export const SHAPE_MIN_SPAN = 6;
/** 一笔最多这么多个点，再大的图形把间距放大（单笔点数上限 2000，留有余量） */
export const SHAPE_MAX_POINTS = 1200;
/**
 * 图形各点的压感：一个恒定值，但不取 0.5。atrament 把恰好 0.5 当作「没有
 * 压感」，改按速度定粗细，每段在目标值上下来回跳 0.25 CSS 像素——手写时看
 * 不出来，在一条笔直的线上就是一节一节的。给一个不是 0.5 的恒定压感，它按
 * 压感定粗细，整笔一样粗（比标称线宽粗 1.4%，看不出来）。自然笔感的图形
 * 不看压感（thinning 为 0），整笔一条路径的笔（荧光笔）也不看。
 */
export const SHAPE_PRESSURE = 0.51;

/** 直线、箭头离水平或竖直不到 5° 时吸附过去 */
const SNAP_TAN = Math.tan((5 * Math.PI) / 180);
/** 箭翼与杆的夹角 */
const ARROW_WING_ANGLE = (28 * Math.PI) / 180;
/** 箭翼长度：线宽的这么多倍，且不短于 ARROW_WING_MIN（逻辑单位） */
const ARROW_WING_WEIGHTS = 6;
const ARROW_WING_MIN = 14;
/** 椭圆的骨架分成这么多小段 */
const ELLIPSE_SIDES = 96;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 起止点的直线距离：拖出了多大 */
export function shapeSpan(from: ShapeXY, to: ShapeXY): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * 直线类图形的终点：接近水平或竖直时吸附到正水平、正竖直（画下划线、坐标轴
 * 不用对得很准）。矩形和椭圆按拖到的位置画。
 */
export function snapShapeEnd(
  shape: InkShapeKind,
  from: ShapeXY,
  to: ShapeXY,
): ShapeXY {
  if (shape !== "line" && shape !== "arrow") return to;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dy <= dx * SNAP_TAN) return { x: to.x, y: from.y };
  if (dx <= dy * SNAP_TAN) return { x: from.x, y: to.y };
  return to;
}

/**
 * 图形的骨架。from 是落笔点，to 是当前（或抬笔时）的位置：
 * - 直线：起点到终点；
 * - 箭头：一笔画完——杆、一侧箭翼、折回箭尖、另一侧箭翼（一个箭头是一笔，
 *   整笔橡皮一下擦掉，笔数也只算一笔）；
 * - 矩形：以两点为对角，从落笔的角出发绕一圈回到原处；
 * - 椭圆：内接于以两点为对角的矩形。
 *
 * @param weight 线宽（坐标单位），箭头的大小跟着它走
 */
export function shapeOutline(
  shape: InkShapeKind,
  from: ShapeXY,
  to: ShapeXY,
  weight: number,
  unit = 1,
): ShapeOutline {
  const start = { x: from.x, y: from.y };
  const end = { x: to.x, y: to.y };
  switch (shape) {
    case "line":
      return { points: [start, end], cornered: true };
    case "arrow": {
      const length = shapeSpan(from, to);
      if (length === 0) return { points: [start, end], cornered: true };
      const wing = Math.min(
        length / 2,
        Math.max(weight * ARROW_WING_WEIGHTS, ARROW_WING_MIN * unit),
      );
      // 从箭尖指回起点的方向，向两边各转一个夹角就是两翼
      const back = Math.atan2(from.y - to.y, from.x - to.x);
      const wingAt = (turn: number): ShapeXY => ({
        x: to.x + wing * Math.cos(back + turn),
        y: to.y + wing * Math.sin(back + turn),
      });
      return {
        points: [
          start,
          end,
          wingAt(ARROW_WING_ANGLE),
          { ...end },
          wingAt(-ARROW_WING_ANGLE),
        ],
        cornered: true,
      };
    }
    case "rect":
      return {
        points: [
          start,
          { x: to.x, y: from.y },
          end,
          { x: from.x, y: to.y },
          { ...start },
        ],
        cornered: true,
      };
    case "ellipse": {
      const cx = (from.x + to.x) / 2;
      const cy = (from.y + to.y) / 2;
      const rx = (to.x - from.x) / 2;
      const ry = (to.y - from.y) / 2;
      const points: ShapeXY[] = [];
      for (let i = 0; i <= ELLIPSE_SIDES; i++) {
        // 最后一个点用和第一个点同一个角度，首尾严格重合
        const angle = ((i % ELLIPSE_SIDES) / ELLIPSE_SIDES) * Math.PI * 2;
        points.push({
          x: cx - rx * Math.cos(angle),
          y: cy - ry * Math.sin(angle),
        });
      }
      return { points, cornered: false };
    }
  }
}

/** 骨架各段的长度、总路程，以及「走了这么远的一个点」怎么落成采样点 */
function measure(outline: ShapeOutline, durationMs: number) {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < outline.points.length; i++) {
    const length = shapeSpan(
      outline.points[i - 1] as ShapeXY,
      outline.points[i] as ShapeXY,
    );
    lengths.push(length);
    total += length;
  }
  const duration = Math.max(0, durationMs);
  const at = (p: ShapeXY, travelled: number): InkStrokePoint => ({
    x: round2(p.x),
    y: round2(p.y),
    p: SHAPE_PRESSURE,
    t: total > 0 ? Math.round((duration * travelled) / total) : 0,
  });
  return { lengths, total, at };
}

/**
 * 骨架 → 只取顶点的点列，不加密：整笔一条路径的笔（荧光笔）用——那种画法
 * 画的就是顶点的连线，点多了没有用处。坐标、压感、时间的口径同
 * shapeStrokePoints。
 */
export function shapeVertexPoints(
  outline: ShapeOutline,
  durationMs: number,
): InkStrokePoint[] {
  const { lengths, at } = measure(outline, durationMs);
  let travelled = 0;
  return outline.points.map((p, i) => {
    if (i > 0) travelled += lengths[i - 1] as number;
    return at(p, travelled);
  });
}

/**
 * 骨架 → 落库的点列：沿骨架等距加密（间距 SHAPE_SPACING，图形太大时放大到
 * 一笔不超过 SHAPE_MAX_POINTS 个点），坐标保留两位小数，压感恒定，时间按
 * 路程从 0 分配到 durationMs（回放时图形按拖动用的时长画出来）。
 */
export function shapeStrokePoints(
  outline: ShapeOutline,
  durationMs: number,
  unit = 1,
): InkStrokePoint[] {
  const vertices = outline.points;
  const first = vertices[0];
  if (first === undefined) return [];
  const { lengths, total, at } = measure(outline, durationMs);
  if (total === 0) return [at(first, 0)];

  const points: InkStrokePoint[] = [at(first, 0)];
  if (outline.cornered) {
    // 每段至多多出一个点（向上取整），每个顶点再补一个重复点
    const reserve = 1 + 2 * lengths.length;
    const spacing = Math.max(
      SHAPE_SPACING * unit,
      total / (SHAPE_MAX_POINTS - reserve),
    );
    let travelled = 0;
    for (let i = 0; i < lengths.length; i++) {
      const a = vertices[i] as ShapeXY;
      const b = vertices[i + 1] as ShapeXY;
      const length = lengths[i] as number;
      const steps = Math.max(1, Math.ceil(length / spacing - 1e-9));
      for (let j = 1; j < steps; j++) {
        const k = j / steps;
        points.push(
          at(
            { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k },
            travelled + length * k,
          ),
        );
      }
      travelled += length;
      // 顶点本身，再补一个重复点（见文件头）
      const corner = at(b, travelled);
      points.push(corner, { ...corner });
    }
    return points;
  }

  // 曲线：不保留骨架的顶点，按路程均分
  const spacing = Math.max(
    SHAPE_SPACING * unit,
    total / (SHAPE_MAX_POINTS - 3),
  );
  const steps = Math.max(8, Math.ceil(total / spacing - 1e-9));
  let segment = 0;
  let before = 0;
  for (let j = 1; j < steps; j++) {
    const target = (total * j) / steps;
    while (
      segment < lengths.length - 1 &&
      before + (lengths[segment] as number) < target
    ) {
      before += lengths[segment] as number;
      segment++;
    }
    const a = vertices[segment] as ShapeXY;
    const b = vertices[segment + 1] as ShapeXY;
    const length = lengths[segment] as number;
    const k = length > 0 ? (target - before) / length : 0;
    points.push(
      at({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, target),
    );
  }
  const last = at(vertices[vertices.length - 1] as ShapeXY, total);
  points.push(last, { ...last });
  return points;
}
