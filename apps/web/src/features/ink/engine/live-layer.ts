/**
 * 书写中那一笔的临时显示层：一块盖在画布上的 SVG，不接指针事件。
 *
 * 整笔一条路径的笔（荧光笔）不能边写边往画布上追加——每追加一段，接头就
 * 叠深一次。书写期间这一笔只放在这一层上，每来一批采样点更新一次路径；抬笔
 * 后由书写面按同一条路径画到画布上，这一层随即清空。
 *
 * 用 SVG 而不是第二块画布：不占位图内存（一张长草稿纸的画布在高分屏上有几十
 * MB），路径数据还能在单测里直接断言。坐标域（viewBox）由宿主设成和笔画相同
 * 的单位，路径和线宽直接用笔画的数值。
 *
 * 橡皮圈也画在这一层：橡皮按下或悬停时跟着走，半径就是橡皮的命中半径。
 */
import { onePathSvg } from "./highlighter-paint.ts";
import type { InkStroke } from "./types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export const INK_LIVE_LAYER_DATA_SLOT = "ink-live-layer";
export const INK_LIVE_LAYER_SELECTOR = `svg[data-slot="${INK_LIVE_LAYER_DATA_SLOT}"]`;
export const INK_ERASER_RING_DATA_SLOT = "ink-eraser-ring";
export const INK_ERASER_RING_SELECTOR = `circle[data-slot="${INK_ERASER_RING_DATA_SLOT}"]`;

export interface InkLiveLayer {
  /** 坐标域：草稿纸为逻辑宽 1000 及对应的高，圈画为底图像素宽高 */
  setViewBox(width: number, height: number): void;
  /** 显示或更新书写中的这一笔；count 缺省为全部采样点 */
  showStroke(
    stroke: Pick<InkStroke, "points" | "color" | "weight">,
    count?: number,
  ): void;
  clear(): void;
  /** 橡皮圈：让人看见橡皮擦到哪儿、多大；圆心与半径用笔画同一单位 */
  showRing(x: number, y: number, radius: number): void;
  hideRing(): void;
  destroy(): void;
}

export function createInkLiveLayer(host: HTMLElement): InkLiveLayer {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("data-slot", INK_LIVE_LAYER_DATA_SLOT);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  svg.style.pointerEvents = "none";

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.style.display = "none";
  svg.appendChild(path);

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("data-slot", INK_ERASER_RING_DATA_SLOT);
  ring.setAttribute("fill", "rgba(255, 255, 255, 0.4)");
  ring.setAttribute("stroke", "rgba(31, 35, 40, 0.55)");
  ring.setAttribute("stroke-width", "1.5");
  // 描边按屏幕像素算，不跟着坐标域缩放变粗变细
  ring.setAttribute("vector-effect", "non-scaling-stroke");
  ring.style.display = "none";
  svg.appendChild(ring);
  host.appendChild(svg);

  function clear(): void {
    path.style.display = "none";
    path.removeAttribute("d");
  }

  return {
    setViewBox(width, height): void {
      if (!(width > 0) || !(height > 0)) return;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    },
    showStroke(stroke, count): void {
      const d = onePathSvg(stroke.points, count);
      if (d === "") {
        clear();
        return;
      }
      path.setAttribute("d", d);
      path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", String(stroke.weight));
      path.style.display = "";
    },
    clear,
    showRing(x, y, radius): void {
      ring.setAttribute("cx", String(x));
      ring.setAttribute("cy", String(y));
      ring.setAttribute("r", String(radius));
      ring.style.display = "";
    },
    hideRing(): void {
      ring.style.display = "none";
    },
    destroy(): void {
      svg.remove();
    },
  };
}
