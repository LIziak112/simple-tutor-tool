/**
 * 合在一起画的笔画（「一组」）。
 *
 * 荧光笔是半透明色，一笔之内只上一次色，深浅处处相同（highlighter-paint.ts）。
 * 局部橡皮把一笔切成几段后，各段成了独立的笔画；若各画各的，原来同一笔里
 * 相互重叠的地方——来回涂的部分、擦着边切开后两个圆头相接的地方——会被
 * 上两次色，比擦之前深一块。切出来的各段带着同一个记号（cutFrom，见
 * erase-partial.ts）：绘制顺序上相邻、记号相同、画法也相同的荧光笔段算一组，
 * 一组只上一次色。
 *
 * 画笔画的地方（书写面整张重画与局部重画、回放、派生图、圈画合成）都按组
 * 画，不逐笔循环。不透明的笔不用成组：重叠处本来就看不出深浅。
 */
import type { InkStroke } from "./types.ts";

type RunStroke = Pick<
  InkStroke,
  "tool" | "color" | "weight" | "rendering" | "cutFrom"
>;

/** 画法参数逐项相同（存取之后各段的参数各是各的对象，不能只比引用） */
function sameRendering(
  a: InkStroke["rendering"],
  b: InkStroke["rendering"],
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.renderer === b.renderer &&
    a.smoothing === b.smoothing &&
    a.thinning === b.thinning &&
    a.streamline === b.streamline &&
    a.sizeScale === b.sizeScale &&
    a.simulatePressure === b.simulatePressure
  );
}

/**
 * 这两笔是否合在一起画：同一笔切出来的荧光笔段。颜色、线宽、画法也要相同
 * ——切出来的段本来就沿用原笔的，这里再核一遍，数据被改过也不会画错颜色。
 */
export function inSamePaintRun(a: RunStroke, b: RunStroke): boolean {
  return (
    a.cutFrom !== undefined &&
    a.cutFrom === b.cutFrom &&
    a.tool === "highlighter" &&
    b.tool === "highlighter" &&
    a.color === b.color &&
    a.weight === b.weight &&
    sameRendering(a.rendering, b.rendering)
  );
}

/**
 * 按绘制顺序把笔画一组一组交给 visit：只有相邻的才并进一组（中间隔着别的
 * 笔画时先后顺序不能乱），不成组的笔画自己一组。
 */
export function forEachPaintRun<T extends RunStroke>(
  strokes: readonly T[],
  visit: (run: readonly T[]) => void,
): void {
  let start = 0;
  while (start < strokes.length) {
    const first = strokes[start];
    let end = start + 1;
    if (first !== undefined) {
      for (
        let next = strokes[end];
        next !== undefined && inSamePaintRun(first, next);
        next = strokes[end]
      ) {
        end += 1;
      }
      visit(strokes.slice(start, end));
    }
    start = end;
  }
}
