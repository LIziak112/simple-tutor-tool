/**
 * 荧光笔的画法：整笔一条路径、一次描边。
 *
 * 荧光笔是半透明色。逐段描边（atrament 的画法）时，相邻两段的圆头在接头处
 * 重叠，颜色叠深成一串珠子；一笔来回涂抹，重叠的地方也越涂越深。整笔作为
 * 一条路径只描一次，浏览器按这条路径覆盖到的区域整体上色，一笔之内透明度
 * 处处相同（两笔之间重叠仍会叠深，和真的荧光笔一样）。
 *
 * 路径只由采样点决定：相邻采样点的中点作曲线端点、采样点作控制点，首尾各补
 * 一段直线到真实端点。同一份指令既画到 canvas（重绘、回放、派生图），也写成
 * SVG 路径数据（书写中的那一笔，见 live-layer.ts），两边形状一致。
 */
import type { InkStroke } from "./types.ts";

type PathPoint = Pick<InkStroke["points"][number], "x" | "y">;

/** traceOnePath 的输出端；CanvasRenderingContext2D 天然满足 */
export interface OnePathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
}

/** none 没有点；dot 只有一个位置（轻点）；path 至少两个不同位置 */
export type OnePathKind = "none" | "dot" | "path";

/**
 * 这一笔是否整笔一条路径：荧光笔是。自然笔感的荧光笔本来就是整笔一个轮廓
 * 填充（freehand-paint.ts），保持原画法。
 */
export function isOnePathStroke(
  stroke: Pick<InkStroke, "tool" | "rendering">,
): boolean {
  return (
    stroke.tool === "highlighter" && stroke.rendering?.renderer !== "freehand"
  );
}

function kindOf(points: readonly PathPoint[], end: number): OnePathKind {
  const first = points[0];
  if (end <= 0 || first === undefined) return "none";
  for (let i = 1; i < end; i++) {
    const pt = points[i];
    if (pt !== undefined && (pt.x !== first.x || pt.y !== first.y))
      return "path";
  }
  return "dot";
}

/**
 * 把前 count 个采样点连成一条路径，指令发给 sink。连续重复的点只算一次；
 * 只有一个位置时发一条原地的零长线（圆头下是一个圆点）。
 */
export function traceOnePath(
  sink: OnePathSink,
  points: readonly PathPoint[],
  count = points.length,
): OnePathKind {
  const end = Math.min(count, points.length);
  let before: PathPoint | undefined;
  let last: PathPoint | undefined;
  let distinct = 0;
  for (let i = 0; i < end; i++) {
    const pt = points[i];
    if (pt === undefined) continue;
    if (last === undefined) {
      sink.moveTo(pt.x, pt.y);
    } else if (pt.x === last.x && pt.y === last.y) {
      continue;
    } else if (before !== undefined) {
      // 第三个点起：上一个采样点作控制点，画到它与当前点的中点
      if (distinct === 2)
        sink.lineTo((before.x + last.x) / 2, (before.y + last.y) / 2);
      sink.quadraticCurveTo(
        last.x,
        last.y,
        (last.x + pt.x) / 2,
        (last.y + pt.y) / 2,
      );
    }
    before = last;
    last = pt;
    distinct++;
  }
  if (last === undefined) return "none";
  sink.lineTo(last.x, last.y);
  return distinct === 1 ? "dot" : "path";
}

/** 最多三位小数：两位小数坐标的中点恰好落在三位上，不带浮点尾数 */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** 同一条路径的 SVG 路径数据（没有点时为空串） */
export function onePathSvg(
  points: readonly PathPoint[],
  count = points.length,
): string {
  let d = "";
  traceOnePath(
    {
      moveTo: (x, y) => {
        d += `M${fmt(x)} ${fmt(y)}`;
      },
      lineTo: (x, y) => {
        d += `L${fmt(x)} ${fmt(y)}`;
      },
      quadraticCurveTo: (cx, cy, x, y) => {
        d += `Q${fmt(cx)} ${fmt(cy)} ${fmt(x)} ${fmt(y)}`;
      },
    },
    points,
    count,
  );
  return d;
}

/**
 * 把一笔画到 canvas 上：整笔一次描边。坐标和线宽都用笔画自己的单位，
 * scale 是这个单位到位图像素的比例；画完还原画笔状态。
 *
 * 调用前设在 context 上的透明度、虚线（回放里「看擦改」的墓碑样式）照常生效。
 */
export function paintOnePathStroke(
  ctx: CanvasRenderingContext2D,
  scale: number,
  stroke: Pick<InkStroke, "points" | "color" | "weight">,
  count = stroke.points.length,
): void {
  const end = Math.min(count, stroke.points.length);
  const kind = kindOf(stroke.points, end);
  const first = stroke.points[0];
  if (kind === "none" || first === undefined) return;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.beginPath();
  if (kind === "dot") {
    // 轻点一下：零长线的圆头是否栅格化各浏览器不一，直接填一个圆点
    ctx.arc(first.x, first.y, stroke.weight / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
  } else {
    traceOnePath(ctx, stroke.points, end);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.weight;
    ctx.stroke();
  }
  ctx.restore();
}

/** 组里只有一个位置的一笔挪出的长度（坐标单位，等于坐标的最小刻度） */
const DOT_NUDGE = 0.01;

/**
 * 把一组笔画（同一笔切出来的荧光笔段，见 paint-runs.ts）画到 canvas 上：
 * 各笔的路径放进同一条路径、只描一次，组内相互重叠的地方不叠深。颜色与
 * 线宽取第一笔的（同组必相同）；坐标、scale 与 paintOnePathStroke 同口径。
 */
export function paintOnePathRun(
  ctx: CanvasRenderingContext2D,
  scale: number,
  strokes: ReadonlyArray<Pick<InkStroke, "points" | "color" | "weight">>,
): void {
  const head = strokes[0];
  if (head === undefined) return;
  if (strokes.length === 1) {
    paintOnePathStroke(ctx, scale, head);
    return;
  }
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.beginPath();
  let traced = false;
  for (const stroke of strokes) {
    const kind = traceOnePath(ctx, stroke.points);
    if (kind === "none") continue;
    traced = true;
    // 只有一个位置的一笔是一条零长线，圆头画不画各浏览器不一：挪出一丁点
    // 长度，让它和其余各笔在同一次描边里落成一个圆点
    const first = stroke.points[0];
    if (kind === "dot" && first !== undefined) {
      ctx.lineTo(first.x + DOT_NUDGE, first.y);
    }
  }
  if (traced) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = head.color;
    ctx.lineWidth = head.weight;
    ctx.stroke();
  }
  ctx.restore();
}
