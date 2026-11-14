/**
 * 回放画布上的荧光笔（整笔一条路径）：在途那一笔只在临时层上，收笔后整笔
 * 一次落到画布。与 draw.test.ts 分开，是因为这里要用真的程序化 atrament
 * 实例（那边整个替换成了桩）。
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onePathSvg } from "../engine/highlighter-paint.ts";
import { INK_LIVE_LAYER_SELECTOR } from "../engine/live-layer.ts";
import { INK_HIGHLIGHTER, type InkStroke } from "../engine/types.ts";
import { createAtramentReplayCanvas } from "./draw.ts";

/** 计数式 2d 上下文桩：只数描边和清屏的次数 */
class CountingContext {
  static strokes = 0;
  static clears = 0;
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  quadraticCurveTo(): void {}
  arc(): void {}
  closePath(): void {}
  stroke(): void {
    CountingContext.strokes += 1;
  }
  fill(): void {}
  clearRect(): void {
    CountingContext.clears += 1;
  }
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  setLineDash(): void {}
}

let resize: () => void;
let getContextSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  CountingContext.strokes = 0;
  CountingContext.clears = 0;
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(
      () => new CountingContext() as unknown as CanvasRenderingContext2D,
    );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  getContextSpy.mockRestore();
  vi.unstubAllGlobals();
});

const pen = (): InkStroke => ({
  tool: "pen",
  color: "#000000",
  weight: 4,
  points: [{ x: 20, y: 20, p: 0.5, t: 0 }],
});
const highlighter = (): InkStroke => ({
  tool: "highlighter",
  color: INK_HIGHLIGHTER.color,
  weight: INK_HIGHLIGHTER.weight,
  points: [
    { x: 100, y: 100, p: 0.5, t: 0 },
    { x: 300, y: 100, p: 0.5, t: 8 },
  ],
});

function livePath(host: HTMLElement): Element | null {
  return host.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
}

/** 创建回放画布；atrament 构造时自己清一次屏，计数从创建之后算起 */
function mountReplay() {
  const host = document.createElement("div");
  const canvas = createAtramentReplayCanvas(host);
  CountingContext.strokes = 0;
  CountingContext.clears = 0;
  return { host, canvas };
}

it("在途荧光笔只显示在临时层，收笔后整笔一次落到画布，不重画旧笔", () => {
  const { host, canvas } = mountReplay();
  const old = [pen()];
  const active = highlighter();
  canvas.drawOrdered(old, 1, active, 1);
  // 旧笔一个采样点一次描边；在途荧光笔不上画布
  expect(CountingContext.strokes).toBe(1);
  expect(livePath(host)?.getAttribute("d")).toBe(onePathSvg(active.points, 1));

  canvas.drawOrdered(old, 1, active, 2);
  expect(CountingContext.strokes).toBe(1);
  const path = livePath(host);
  expect(path?.getAttribute("d")).toBe(onePathSvg(active.points));
  expect(path?.getAttribute("stroke")).toBe(INK_HIGHLIGHTER.color);
  expect(path?.getAttribute("stroke-width")).toBe(
    String(INK_HIGHLIGHTER.weight),
  );
  // 临时层盖在回放画布之上，坐标域是逻辑宽 1000（容器无尺寸时按 300×200）
  const layer = host.querySelector(INK_LIVE_LAYER_SELECTOR);
  expect(layer?.previousElementSibling?.getAttribute("data-slot")).toBe(
    "ink-replay-canvas",
  );
  expect(layer?.getAttribute("viewBox")).toBe("0 0 1000 666.67");

  const committed = [...old, active];
  canvas.drawOrdered(committed, 2, null, 0);
  expect(CountingContext.strokes).toBe(2);
  expect(CountingContext.clears).toBe(1);
  expect(livePath(host)?.hasAttribute("d")).toBe(false);
  // 同一帧再画一次：什么都不动
  canvas.drawOrdered(committed, 2, null, 0);
  expect(CountingContext.strokes).toBe(2);
  canvas.destroy();
  expect(host.querySelector(INK_LIVE_LAYER_SELECTOR)).toBeNull();
});

it("丢弃在途荧光笔：临时层清空，画布按现存笔画重画", () => {
  const { host, canvas } = mountReplay();
  const old = [pen()];
  canvas.drawOrdered(old, 1, highlighter(), 2);
  canvas.drawOrdered(old, 1, null, 0);
  expect(livePath(host)?.hasAttribute("d")).toBe(false);
  expect(CountingContext.clears).toBe(2);
  expect(CountingContext.strokes).toBe(2);
  canvas.destroy();
});

it("紧接着写下一笔荧光笔：上一笔落到画布，临时层换成新的一笔", () => {
  const { host, canvas } = mountReplay();
  const first = highlighter();
  canvas.drawOrdered([], 0, first, 2);
  const second: InkStroke = {
    ...highlighter(),
    points: [
      { x: 100, y: 200, p: 0.5, t: 0 },
      { x: 300, y: 220, p: 0.5, t: 8 },
    ],
  };
  canvas.drawOrdered([first], 1, second, 2);
  expect(CountingContext.strokes).toBe(1);
  expect(CountingContext.clears).toBe(1);
  expect(livePath(host)?.getAttribute("d")).toBe(onePathSvg(second.points));
  canvas.destroy();
});

it("尺寸变化：在途荧光笔留在临时层，坐标域跟着更新", () => {
  const { host, canvas } = mountReplay();
  const active = highlighter();
  canvas.drawOrdered([pen()], 1, active, 2);
  vi.spyOn(host, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(host, "clientHeight", "get").mockReturnValue(300);
  resize();
  expect(
    host.querySelector(INK_LIVE_LAYER_SELECTOR)?.getAttribute("viewBox"),
  ).toBe("0 0 1000 500");
  expect(livePath(host)?.getAttribute("d")).toBe(onePathSvg(active.points));
  // 重设位图后旧笔重画一次；荧光笔仍不上画布
  expect(CountingContext.strokes).toBe(2);
  canvas.destroy();
});

it("改用整帧重画（回放拖动）时临时层清空，荧光笔每笔一次描边", () => {
  const { host, canvas } = mountReplay();
  const active = highlighter();
  canvas.drawOrdered([], 0, active, 2);
  expect(CountingContext.strokes).toBe(0);
  canvas.drawFrame([active, highlighter()], [2, 1]);
  expect(livePath(host)?.hasAttribute("d")).toBe(false);
  // 第二笔只走过一个采样点：是一个圆点（填充，不描边）
  expect(CountingContext.strokes).toBe(1);
  canvas.destroy();
});

it("没有在途荧光笔就不创建临时层（纯回放页的 DOM 不变）", () => {
  const { host, canvas } = mountReplay();
  canvas.drawOrdered([highlighter()], 1, pen(), 1);
  canvas.drawFrame([highlighter(), pen()], [2, 1]);
  expect(host.querySelector(INK_LIVE_LAYER_SELECTOR)).toBeNull();
  expect(host.children).toHaveLength(1);
  canvas.destroy();
});
