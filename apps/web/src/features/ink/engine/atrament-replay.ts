/**
 * 按矢量把笔画画到 canvas 上的共用原语：实时书写后的全量重绘、回放、派生图
 * 渲染与圈画合成都走这里，不各写一份笔迹绘制。
 *
 * 一笔怎么画由笔画自身决定：
 * - 自然笔感（rendering.renderer 为 freehand）：整笔一个轮廓填充；
 * - 荧光笔：整笔一条路径、一次描边（见 highlighter-paint.ts）；
 * - 其余：atrament 官方程序化绘制（beginStroke / draw / endStroke），逐段描边。
 *
 * 画一串笔画用 replayAtramentStrokes：同一笔被局部橡皮切出来的荧光笔各段
 * 要合在一起上一次色（见 paint-runs.ts），不能逐笔调 replayAtramentStroke。
 */
import Atrament from "atrament";
import { paintFreehandRun, paintFreehandStroke } from "./freehand-paint";
import {
  isOnePathStroke,
  paintOnePathRun,
  paintOnePathStroke,
} from "./highlighter-paint.ts";
import { fromLogical, fromLogicalPoint } from "./normalize.ts";
import { forEachPaintRun } from "./paint-runs.ts";
import {
  INK_DEFAULT_SMOOTHING,
  INK_LOGICAL_WIDTH,
  type InkStroke,
} from "./types.ts";

const drawingCanvases = new WeakMap<Atrament, HTMLCanvasElement>();

/**
 * 整笔一条路径的笔画（荧光笔）画到 atrament 所在的画布上。不是这类笔画、
 * 或实例不是 createProgrammaticAtrament 造的，返回 false，由调用方逐段画。
 *
 * @param cssPerUnit 笔画坐标的一个单位合多少 CSS 像素。CSS → 位图的比例照
 * atrament 自己的换算（位图宽 / offsetWidth），两种画法落在同一位置。
 * @param fallbackCssWidth 画布没有布局宽度（单测环境）时当作它的 CSS 宽
 */
export function paintOnePathOnAtrament(
  atrament: Atrament,
  cssPerUnit: number,
  s: InkStroke,
  fallbackCssWidth?: number,
): boolean {
  if (!isOnePathStroke(s)) return false;
  const canvas = drawingCanvases.get(atrament);
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return false;
  const cssWidth = canvas.offsetWidth || fallbackCssWidth || canvas.width;
  paintOnePathStroke(context, (canvas.width / cssWidth) * cssPerUnit, s);
  return true;
}

/**
 * 把一组笔画（同一笔切出来的荧光笔段，见 paint-runs.ts）一次画到 atrament
 * 所在的画布上。实例不是 createProgrammaticAtrament 造的返回 false，由调用方
 * 逐笔画。参数同 paintOnePathOnAtrament。
 */
export function paintRunOnAtrament(
  atrament: Atrament,
  cssPerUnit: number,
  run: readonly InkStroke[],
  fallbackCssWidth?: number,
): boolean {
  const head = run[0];
  const canvas = drawingCanvases.get(atrament);
  const context = canvas?.getContext("2d");
  if (head === undefined || !canvas || !context) return false;
  const cssWidth = canvas.offsetWidth || fallbackCssWidth || canvas.width;
  const scale = (canvas.width / cssWidth) * cssPerUnit;
  if (head.rendering?.renderer === "freehand") {
    paintFreehandRun(context, scale, run, head.rendering);
  } else {
    paintOnePathRun(context, scale, run);
  }
  return true;
}

/**
 * 按逻辑坐标在 Atrament 实例上按顺序重放一串笔画：同一笔切出来的荧光笔各段
 * 合在一起上一次色，其余逐笔画。
 * @param cssWidth 当前容器 CSS 宽（逻辑 1000 → 实际像素的换算基准）
 */
export function replayAtramentStrokes(
  atrament: Atrament,
  cssWidth: number,
  strokes: readonly InkStroke[],
): void {
  forEachPaintRun(strokes, (run) => {
    if (
      run.length > 1 &&
      paintRunOnAtrament(atrament, cssWidth / INK_LOGICAL_WIDTH, run, cssWidth)
    )
      return;
    for (const stroke of run) replayAtramentStroke(atrament, cssWidth, stroke);
  });
}

/**
 * 按逻辑坐标在 Atrament 实例上重放一笔。
 * @param cssWidth 当前容器 CSS 宽（逻辑 1000 → 实际像素的换算基准）
 */
export function replayAtramentStroke(
  atrament: Atrament,
  cssWidth: number,
  s: InkStroke,
): void {
  const canvas = drawingCanvases.get(atrament);
  if (s.rendering?.renderer === "freehand" && canvas) {
    const context = canvas.getContext("2d");
    if (context)
      paintFreehandStroke(
        context,
        ((canvas.width / (canvas.offsetWidth || cssWidth)) * cssWidth) / 1000,
        s,
        s.rendering,
      );
    return;
  }
  if (
    paintOnePathOnAtrament(atrament, cssWidth / INK_LOGICAL_WIDTH, s, cssWidth)
  )
    return;
  const stroke = beginAtramentStroke(atrament, cssWidth, s);
  stroke?.appendThrough(s.points.length);
  stroke?.end();
}

/** 同一笔复用平滑后的上一点，按原顺序只绘制新增线段。 */
export function beginAtramentStroke(
  atrament: Atrament,
  cssWidth: number,
  s: InkStroke,
) {
  const first = s.points[0];
  if (!first) return null;
  atrament.smoothing = s.rendering?.smoothing ?? 0.35;
  atrament.color = s.color;
  atrament.weight = fromLogical(cssWidth, s.weight);
  let prev = fromLogicalPoint(cssWidth, first.x, first.y);
  let drawn = 0;
  atrament.beginStroke(prev.x, prev.y);
  return {
    appendThrough(count: number): void {
      for (; drawn < count; drawn++) {
        const pt = s.points[drawn];
        if (!pt) break;
        const at = fromLogicalPoint(cssWidth, pt.x, pt.y);
        prev = atrament.draw(at.x, at.y, prev.x, prev.y, pt.p);
      }
    },
    end(): void {
      atrament.endStroke(prev.x, prev.y);
    },
  };
}

/**
 * 构造仅用于**程序化重放**的 Atrament 实例：构造即配置 canvas 2d 画笔状态
 * （source-over / lineCap round / lineJoin round），随即 destroy() 解绑其
 * 内部指针监听——后续只经 replayAtramentStroke / beginStroke/draw/endStroke
 * 驱动绘制，不接管任何输入。书写面（输入层自管）、笔迹回放（replay/draw）、
 * 草稿渲染器（notes/render-note）与圈画共用这一手法。
 */
export function createProgrammaticAtrament(
  canvas: HTMLCanvasElement,
): Atrament {
  const atrament = new Atrament(canvas, { smoothing: INK_DEFAULT_SMOOTHING });
  drawingCanvases.set(atrament, canvas);
  atrament.destroy();
  return atrament;
}
