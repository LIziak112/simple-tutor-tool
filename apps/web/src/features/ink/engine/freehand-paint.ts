import type { InkRendering, InkStroke } from "@tutor/contract";
import { getStroke } from "perfect-freehand";

/** 一笔的轮廓点；没有点的笔画是空数组 */
function outlineOf(
  stroke: InkStroke,
  config: InkRendering,
  complete: boolean,
): number[][] {
  return getStroke(
    stroke.points.map((p) => ({ x: p.x, y: p.y, pressure: p.p })),
    {
      size: stroke.weight * config.sizeScale,
      thinning: stroke.tool === "highlighter" ? 0 : config.thinning,
      smoothing: Math.min(1, config.smoothing),
      streamline: config.streamline,
      simulatePressure: config.simulatePressure,
      last: complete,
    },
  );
}

/** 把一个轮廓作为一条闭合的子路径加进当前路径 */
function traceOutline(ctx: CanvasRenderingContext2D, outline: number[][]) {
  const first = outline[0];
  if (!first) return;
  ctx.moveTo(first[0] ?? 0, first[1] ?? 0);
  let previous = first;
  for (const p of outline.slice(1)) {
    ctx.quadraticCurveTo(
      previous[0] ?? 0,
      previous[1] ?? 0,
      ((previous[0] ?? 0) + (p[0] ?? 0)) / 2,
      ((previous[1] ?? 0) + (p[1] ?? 0)) / 2,
    );
    previous = p;
  }
  ctx.quadraticCurveTo(
    previous[0] ?? 0,
    previous[1] ?? 0,
    first[0] ?? 0,
    first[1] ?? 0,
  );
  ctx.closePath();
}

/** 编辑、派生图片与回放共用轮廓绘制，scale 是逻辑坐标到位图的比例。 */
export function paintFreehandStroke(
  ctx: CanvasRenderingContext2D,
  scale: number,
  stroke: InkStroke,
  config: InkRendering,
  complete = true,
) {
  paintFreehandRun(ctx, scale, [stroke], config, complete);
}

/**
 * 把一组笔画（同一笔切出来的荧光笔段，见 paint-runs.ts）画到 canvas 上：
 * 各笔的轮廓放进同一条路径、只填一次，组内相互重叠的地方不叠深。各轮廓的
 * 绕向一致（perfect-freehand 恒按「左侧去、右侧回」给点），非零环绕规则下
 * 两段重叠的地方环绕数同号相加、照样填上。颜色取第一笔的（同组必相同）。
 *
 * 已知限制：一笔的轮廓自己绕出反向的小圈时（采样很稀、每个采样点都折回
 * 120° 以上的急转弯，轮廓内侧会翻出一个反向的环），这个环的环绕数与别的段
 * 相加可能恰好为零，重叠处留下一个没上色的小洞。压感笔的连续采样和图形
 * 工具的点列（加密过或只有两点）走不到这种形状；要彻底消除得先在离屏画布
 * 上不透明地填好再整体合成一次，本轮没有做。
 */
export function paintFreehandRun(
  ctx: CanvasRenderingContext2D,
  scale: number,
  strokes: readonly InkStroke[],
  config: InkRendering,
  complete = true,
) {
  const color = strokes[0]?.color;
  const outlines = strokes
    .map((stroke) => outlineOf(stroke, config, complete))
    .filter((outline) => outline.length > 0);
  if (color === undefined || outlines.length === 0) return;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const outline of outlines) traceOutline(ctx, outline);
  ctx.fill();
  ctx.restore();
}
