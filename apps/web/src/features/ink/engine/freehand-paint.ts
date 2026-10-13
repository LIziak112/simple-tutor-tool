import type { InkRendering, InkStroke } from "@tutor/contract";
import { getStroke } from "perfect-freehand";
/** 编辑、派生图片与回放共用轮廓绘制，scale 是逻辑坐标到位图的比例。 */
export function paintFreehandStroke(
  ctx: CanvasRenderingContext2D,
  scale: number,
  stroke: InkStroke,
  config: InkRendering,
  complete = true,
) {
  const outline = getStroke(
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
  const first = outline[0];
  if (!first) return;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
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
  ctx.fill();
  ctx.restore();
}
