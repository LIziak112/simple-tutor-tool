/**
 * 圈画笔画的重放：在底图像素域内把笔画画到 atrament 所在的画布上。书写面
 * 的重绘、合成图（annotation-composite）、当前题渲染与只读画布共用。
 *
 * 画一串笔画用 replayAnnotationStrokes：同一笔被局部橡皮切出来的荧光笔各段
 * 要合在一起上一次色（见 engine/paint-runs），不能逐笔调 replayAnnotationStroke。
 */
import type Atrament from "atrament";
import {
  paintOnePathOnAtrament,
  paintRunOnAtrament,
} from "@/features/ink/engine/atrament-replay.ts";
import { forEachPaintRun } from "@/features/ink/engine/paint-runs.ts";
import type { InkStroke } from "@/features/ink/engine/types.ts";

/**
 * 在底图像素域内按顺序重放一串笔画：同一笔切出来的荧光笔各段合在一起上
 * 一次色，其余逐笔画。cssPerBase 同 replayAnnotationStroke。
 */
export function replayAnnotationStrokes(
  atrament: Atrament,
  cssPerBase: number,
  strokes: readonly InkStroke[],
): void {
  forEachPaintRun(strokes, (run) => {
    if (run.length > 1 && paintRunOnAtrament(atrament, cssPerBase, run)) return;
    for (const stroke of run)
      replayAnnotationStroke(atrament, cssPerBase, stroke);
  });
}

/**
 * 在底图像素域内按一笔重放（atrament 官方程序化绘制；CSS 坐标桥接）。
 *
 * atrament 以 **CSS 单位**收点与线宽，内部乘 canvas.width/offsetWidth 落
 * 位图。cssPerBase = CSS 像素/底图像素：坐标 base×cssPerBase、线宽
 * weight_base×cssPerBase 交给 atrament 后，净落位图值 = 原底图像素值。
 * 荧光笔整笔一次描边（同一换算，见 engine/highlighter-paint）。
 */
export function replayAnnotationStroke(
  atrament: Atrament,
  cssPerBase: number,
  s: InkStroke,
): void {
  if (s.points.length === 0) return;
  if (paintOnePathOnAtrament(atrament, cssPerBase, s)) return;
  atrament.color = s.color;
  atrament.weight = s.weight * cssPerBase;
  const first = s.points[0];
  if (!first) return;
  const sx = first.x * cssPerBase;
  const sy = first.y * cssPerBase;
  atrament.beginStroke(sx, sy);
  let prev = atrament.draw(sx, sy, sx, sy, first.p);
  for (let i = 1; i < s.points.length; i++) {
    const pt = s.points[i];
    if (!pt) continue;
    const x = pt.x * cssPerBase;
    const y = pt.y * cssPerBase;
    prev = atrament.draw(x, y, prev.x, prev.y, pt.p);
  }
  atrament.endStroke(prev.x, prev.y);
}
