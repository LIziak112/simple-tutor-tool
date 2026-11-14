import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  INK_ERASER_RING_SELECTOR,
  INK_LIVE_LAYER_SELECTOR,
} from "../engine/live-layer";
import { createFeelSurface, DEFAULT_FEEL_PARAMS } from "./feel-surface";

class ContextStub {
  clearRect = vi.fn();
  fill = vi.fn();
  save() {}
  restore() {}
  setTransform() {}
  beginPath() {}
  moveTo() {}
  quadraticCurveTo() {}
  closePath() {}
  fillRect() {}
  drawImage() {}
  rect() {}
  clip() {}
}

let surface: ReturnType<typeof createFeelSurface>;
let canvas: HTMLCanvasElement;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let resizeCallback: (() => void) | null = null;
beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => new ContextStub() as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({ left: 0, top: 0, width: 500, height: 400 } as DOMRect);
  mountSurface();
});
/** 挂一块 500×400 的书写面（缺省是实验页的用法）；重复调用先拆掉上一块 */
function mountSurface(options?: Parameters<typeof createFeelSurface>[1]) {
  surface?.destroy();
  document.body.replaceChildren();
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: 500, configurable: true },
    clientHeight: { value: 400 },
  });
  document.body.append(host);
  surface = createFeelSurface(
    { ...DEFAULT_FEEL_PARAMS, prediction: true },
    options,
  );
  surface.mount(host);
  const target = host.querySelector<HTMLCanvasElement>("[data-slot=feel-wet]");
  if (!target) throw new Error("实验画布未挂载");
  canvas = target;
}
afterEach(() => {
  surface?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function send(type: string, x = 20, id = 1, stamp = x, extra = {}) {
  const event = new Event(type);
  Object.assign(event, {
    pointerId: id,
    pointerType: "pen",
    button: 0,
    buttons: 1,
    pressure: 0.5,
    clientX: x,
    clientY: 20,
    ...extra,
  });
  Object.defineProperty(event, "timeStamp", { value: stamp });
  canvas.dispatchEvent(event);
}
function points() {
  const doc = surface.getDoc();
  return doc.engine === "atrament" ? doc.data.strokes.map((s) => s.points) : [];
}
function drawFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

it("自然笔感橡皮快速拖动扫过笔画，远处笔迹不变且可一步撤销", () => {
  send("pointerdown", 150, 1, 0, { clientY: 20 });
  send("pointermove", 150, 1, 10, { clientY: 100 });
  send("pointerup", 150, 1, 20, { clientY: 100 });
  send("pointerdown", 350, 1, 30, { clientY: 20 });
  send("pointermove", 350, 1, 40, { clientY: 100 });
  send("pointerup", 350, 1, 50, { clientY: 100 });
  const original = points();
  surface.setTool({ type: "eraser" });
  send("pointerdown", 100, 1, 60, { clientY: 60 });
  send("pointermove", 200, 1, 70, { clientY: 60 });
  send("pointerup", 200, 1, 80, { clientY: 60 });
  expect(points()).toEqual([original[1]]);
  surface.undo();
  expect(points()).toEqual(original);
});

it("橡皮大小决定命中范围：小号擦不到的距离中号擦得到，更远只有大号擦得到", () => {
  // 竖线 x=150；画布宽 500 → 1 CSS px = 2 逻辑单位，笔宽 4（半宽 2）
  let stamp = 0;
  const line = () => {
    send("pointerdown", 150, 1, ++stamp, { clientY: 20 });
    send("pointermove", 150, 1, ++stamp, { clientY: 100 });
    send("pointerup", 150, 1, ++stamp, { clientY: 100 });
  };
  const tapAt = (x: number) => {
    send("pointerdown", x, 1, ++stamp, { clientY: 60 });
    send("pointerup", x, 1, ++stamp, { clientY: 60 });
  };
  line();
  // 离线 6px = 12 逻辑单位：小号 8+2 够不着，中号 14+2 够得着
  surface.setTool({ type: "eraser", size: "small" });
  tapAt(156);
  expect(points()).toHaveLength(1);
  surface.setTool({ type: "eraser", size: "medium" });
  tapAt(156);
  expect(points()).toHaveLength(0);

  surface.setTool({ type: "pen" });
  line();
  // 离线 10px = 20 逻辑单位：缺省中号够不着，大号 24+2 够得着
  surface.setTool({ type: "eraser" });
  tapAt(160);
  expect(points()).toHaveLength(1);
  surface.setTool({ type: "eraser", size: "large" });
  tapAt(160);
  expect(points()).toHaveLength(0);
});

/** 横线 CSS (100,60) → (300,60)，即逻辑 (200,120) → (600,120)；笔宽 4 */
function drawLine() {
  send("pointerdown", 100, 1, 1, { clientY: 60 });
  send("pointermove", 300, 1, 2, { clientY: 60 });
  send("pointerup", 300, 1, 3, { clientY: 60 });
}
function ring() {
  const node = canvas.parentElement?.querySelector<SVGElement>(
    INK_ERASER_RING_SELECTOR,
  );
  if (!node) throw new Error("缺少橡皮圈");
  return {
    shown: node.style.display !== "none",
    at: ["cx", "cy", "r"].map((name) => Number(node.getAttribute(name))),
  };
}

it("局部橡皮：只擦掉碰到的一段，两头各成一笔；拖动途中正文不变，一次拖动一步撤销", () => {
  drawLine();
  surface.setTool({ type: "eraser", mode: "partial", size: "small" });
  // 落点逻辑 x=400；小号半径 8 + 半笔宽 2 → 切掉 390–410
  send("pointerdown", 200, 1, 10, { clientY: 60 });
  expect(points()).toHaveLength(1);
  send("pointermove", 220, 1, 11, { clientY: 60 });
  send("pointerup", 220, 1, 12, { clientY: 60 });
  const xs = () => points().map((stroke) => stroke.map((point) => point.x));
  expect(xs()).toEqual([
    [200, 390],
    [450, 600],
  ]);
  surface.undo();
  expect(xs()).toEqual([[200, 600]]);
  surface.redo();
  expect(xs()).toEqual([
    [200, 390],
    [450, 600],
  ]);
});

it("局部橡皮被第二指针打断：按已擦的提交；橡皮缺省仍是整笔擦", () => {
  drawLine();
  surface.setTool({ type: "eraser", mode: "partial", size: "small" });
  send("pointerdown", 200, 1, 10, { clientY: 60 });
  send("pointerdown", 400, 2, 11, { clientY: 300 });
  expect(points()).toHaveLength(2);
  surface.setTool({ type: "eraser" });
  send("pointerdown", 120, 3, 20, { clientY: 60 });
  send("pointerup", 120, 3, 21, { clientY: 60 });
  expect(points()).toHaveLength(1);
});

it("橡皮圈：悬停着纸面变成不可写（收起、交卷）就收起，不留在纸上", () => {
  surface.setTool({ type: "eraser" });
  send("pointermove", 120, 1, 1, {
    clientY: 60,
    buttons: 0,
    pointerType: "mouse",
  });
  expect(ring().shown).toBe(true);
  surface.setInputEnabled?.(false);
  expect(ring().shown).toBe(false);
});

it("橡皮圈：按下显示在落点、拖动跟着走、抬起收起；悬停显示，移出画布或换工具收起", () => {
  const layer = canvas.parentElement?.querySelector(INK_LIVE_LAYER_SELECTOR);
  expect(layer?.getAttribute("viewBox")).toBe("0 0 1000 800");
  const hover = (stamp: number) =>
    send("pointermove", 120, 1, stamp, {
      clientY: 60,
      buttons: 0,
      pointerType: "mouse",
    });
  hover(1);
  expect(ring().shown).toBe(false);

  surface.setTool({ type: "eraser", size: "large" });
  send("pointerdown", 100, 1, 10, { clientY: 60 });
  expect(ring()).toEqual({ shown: true, at: [200, 120, 24] });
  send("pointermove", 150, 1, 11, { clientY: 60 });
  expect(ring().at).toEqual([300, 120, 24]);
  send("pointerup", 150, 1, 12, { clientY: 60 });
  expect(ring().shown).toBe(false);

  hover(20);
  expect(ring()).toEqual({ shown: true, at: [240, 120, 24] });
  send("pointerleave", 120, 1, 21);
  expect(ring().shown).toBe(false);
  hover(22);
  surface.setTool({ type: "pen" });
  expect(ring().shown).toBe(false);
});

it("正式手写（各笔保留自己的画法）局部擦除只重画改动的那一块；实验页调参会换掉全部笔画的画法，整张重画", () => {
  const clip = vi.spyOn(ContextStub.prototype, "clip");
  drawLine();
  surface.setTool({ type: "eraser", mode: "partial" });
  send("pointerdown", 200, 1, 10, { clientY: 60 });
  send("pointerup", 200, 1, 11, { clientY: 60 });
  expect(points()).toHaveLength(2);
  expect(clip).not.toHaveBeenCalled();

  mountSurface({ preserveRendering: true });
  drawLine();
  surface.setTool({ type: "eraser", mode: "partial" });
  send("pointerdown", 200, 1, 10, { clientY: 60 });
  expect(clip).toHaveBeenCalledTimes(1);
  // 没有新改动的落点不重画
  send("pointermove", 201, 1, 11, { clientY: 60 });
  send("pointermove", 200, 1, 12, { clientY: 60 });
  expect(clip).toHaveBeenCalledTimes(2);
  send("pointerup", 200, 1, 13, { clientY: 60 });
  expect(points()).toHaveLength(2);
});

function strokes() {
  const doc = surface.getDoc();
  return doc.engine === "atrament" ? doc.data.strokes : [];
}
/** 图形预览所在的临时层路径 */
function livePath() {
  const path = canvas.parentElement?.querySelector(
    `${INK_LIVE_LAYER_SELECTOR} path`,
  );
  if (!path) throw new Error("缺少临时层路径");
  return path;
}

it("图形：拖动途中只在临时层上出预览，抬笔落成一笔等宽的笔画（点都在图形上），一步撤销", () => {
  mountSurface({ preserveRendering: true });
  const painted = vi.spyOn(ContextStub.prototype, "closePath");
  surface.setTool({ type: "shape", shape: "rect", color: "red", size: "thin" });
  // CSS (50,50) → (250,150) 即逻辑 (100,100) → (500,300)
  send("pointerdown", 50, 1, 0, { clientY: 50 });
  send("pointermove", 250, 1, 300, { clientY: 150 });
  expect(livePath().getAttribute("d")).toBe(
    "M100 100L500 100L500 300L100 300L100 100",
  );
  expect(livePath().getAttribute("stroke")).toBe("#dc2626");
  expect(livePath().getAttribute("stroke-width")).toBe("2.5");
  drawFrame();
  expect(painted).not.toHaveBeenCalled();
  expect(strokes()).toHaveLength(0);
  expect(surface.getStats().livePoints).toBe(0);

  send("pointerup", 250, 1, 320, { clientY: 150 });
  expect(livePath().hasAttribute("d")).toBe(false);
  expect(painted).toHaveBeenCalledTimes(1);
  const [stroke] = strokes();
  expect(strokes()).toHaveLength(1);
  expect(stroke).toMatchObject({
    tool: "pen",
    color: "#dc2626",
    weight: 2.5,
    pointer: "pen",
    // 等宽、点不滞后：直边是直的，拐角不被抹圆
    rendering: {
      renderer: "freehand",
      smoothing: DEFAULT_FEEL_PARAMS.smoothing,
      thinning: 0,
      streamline: 0,
      sizeScale: DEFAULT_FEEL_PARAMS.sizeScale,
      simulatePressure: false,
    },
  });
  expect(stroke?.id).toEqual(expect.any(String));
  expect(stroke?.points[0]).toEqual({ x: 100, y: 100, p: 0.51, t: 0 });
  expect(stroke?.points.at(-1)).toEqual({ x: 100, y: 100, p: 0.51, t: 300 });
  expect(stroke?.points.length).toBeGreaterThan(300);
  for (const p of stroke?.points ?? []) {
    expect(p.x === 100 || p.x === 500 || p.y === 100 || p.y === 300).toBe(true);
  }
  surface.undo();
  expect(strokes()).toHaveLength(0);
  surface.redo();
  expect(strokes()).toHaveLength(1);
});

it("图形：只点一下不落笔；拖出画布只画到边；第二指针到达时按拖到的位置落笔", () => {
  surface.setTool({ type: "shape", shape: "line" });
  send("pointerdown", 50, 1, 0, { clientY: 50 });
  send("pointerup", 50, 1, 10, { clientY: 50 });
  expect(strokes()).toHaveLength(0);
  expect(surface.canUndo()).toBe(false);

  // 画布 500×400 → 逻辑 1000×800；往右下拖出画布
  send("pointerdown", 400, 2, 20, { clientY: 300 });
  send("pointermove", 700, 2, 30, { clientY: 600 });
  send("pointerup", 700, 2, 40, { clientY: 600 });
  expect(strokes()).toHaveLength(1);
  expect(strokes()[0]?.points.at(-1)).toMatchObject({ x: 1000, y: 800 });

  send("pointerdown", 50, 3, 50, { clientY: 50 });
  send("pointermove", 250, 3, 60, { clientY: 50 });
  send("pointerdown", 300, 4, 70, { clientY: 300 });
  expect(strokes()).toHaveLength(2);
  expect(strokes()[1]?.points.at(-1)).toMatchObject({ x: 500, y: 100 });
  expect(livePath().hasAttribute("d")).toBe(false);
});

it("图形预览的线宽带上粗细倍率；直线荧光笔落成只有起止两点的荧光笔笔画", () => {
  surface.setParams({ ...DEFAULT_FEEL_PARAMS, sizeScale: 1.5 });
  surface.setTool({ type: "shape", shape: "ellipse" });
  send("pointerdown", 50, 1, 0, { clientY: 50 });
  send("pointermove", 250, 1, 10, { clientY: 150 });
  // 中号笔 4 × 1.5
  expect(livePath().getAttribute("stroke-width")).toBe("6");
  send("pointerup", 250, 1, 20, { clientY: 150 });
  expect(strokes()[0]?.rendering).toMatchObject({ sizeScale: 1.5 });

  surface.setTool({ type: "highlighter", straight: true });
  send("pointerdown", 50, 2, 30, { clientY: 100 });
  send("pointermove", 150, 2, 40, { clientY: 120 });
  // 接近水平：吸附
  send("pointermove", 250, 2, 50, { clientY: 103 });
  expect(livePath().getAttribute("d")).toBe("M100 200L500 200");
  send("pointerup", 250, 2, 60, { clientY: 103 });
  const straight = strokes()[1];
  expect(straight?.tool).toBe("highlighter");
  expect(straight?.points).toEqual([
    { x: 100, y: 200, p: 0.51, t: 0 },
    { x: 500, y: 200, p: 0.51, t: 20 },
  ]);

  // 不带直线选项的荧光笔照旧是手写轨迹，画法参数照旧
  surface.setTool({ type: "highlighter" });
  send("pointerdown", 50, 3, 70, { clientY: 300 });
  send("pointermove", 150, 3, 80, { clientY: 320 });
  send("pointerup", 150, 3, 90, { clientY: 320 });
  expect(strokes()[2]?.points).toHaveLength(2);
  expect(strokes()[2]?.rendering).toMatchObject({
    streamline: DEFAULT_FEEL_PARAMS.streamline,
    thinning: DEFAULT_FEEL_PARAMS.thinning,
  });
});

it("预测只显示；真实点替换预测，取消不补造终点", () => {
  send("pointerdown");
  send("pointermove", 30, 1, 30, {
    getPredictedEvents: () => [
      { clientX: 90, clientY: 20, pressure: 0.5, timeStamp: 45 },
    ],
  });
  expect(surface.getStats().predictionPoints).toBe(1);
  send("pointermove", 40);
  expect(surface.getStats().predictionPoints).toBe(0);
  send("pointercancel", 900);
  expect(points()[0]?.map((p) => p.x)).toEqual([40, 60, 80]);
  expect(surface.getStats().predictionPoints).toBe(0);
});
it("空闲 raw 不封锁 move；raw 与 move 去重后仍读 move 的预测", () => {
  send("pointerrawupdate", 10, 9);
  send("pointerdown");
  send("pointerrawupdate", 30);
  send("pointermove", 30, 1, 30, {
    getPredictedEvents: () => [
      { clientX: 40, clientY: 20, pressure: 0.5, timeStamp: 40 },
    ],
  });
  expect(surface.getStats().predictionPoints).toBe(1);
  send("pointerup", 30);
  expect(points()[0]).toHaveLength(2);
  send("pointerdown", 50, 2);
  send("pointermove", 60, 2);
  send("pointerup", 60, 2);
  expect(points()[1]).toHaveLength(2);
});
it("第二指针不会丢第一笔；切工具先收笔，失焦后不粘笔", () => {
  send("pointerdown");
  send("pointermove", 30);
  send("pointerdown", 70, 2);
  expect(points()[0]).toHaveLength(2);
  surface.setTool({ type: "eraser" });
  expect(points()[1]).toHaveLength(1);
  surface.setTool({ type: "pen" });
  send("pointerdown", 80, 3);
  window.dispatchEvent(new Event("blur"));
  send("pointermove", 100, 3);
  expect(points()[2]).toHaveLength(1);
});
it("手指滚动模式不落墨，切模式或关闭输入收束在途笔", () => {
  send("pointerdown", 20, 1, 20, { pointerType: "touch" });
  send("pointerup", 20, 1, 20, { pointerType: "touch" });
  expect(points()).toHaveLength(0);
  surface.setInputMode?.("finger");
  send("pointerdown", 30, 2, 30, { pointerType: "touch" });
  surface.setInputEnabled?.(false);
  send("pointermove", 60, 2, 60, { pointerType: "touch" });
  expect(points()[0]).toHaveLength(1);
});
it("静止一笔只画一帧；调参重新绘制，销毁取消帧", () => {
  send("pointerdown");
  drawFrame();
  expect(frames.size).toBe(0);
  surface.setParams({ ...DEFAULT_FEEL_PARAMS, streamline: 0.1 });
  expect(points()[0]).toHaveLength(1);
  send("pointerdown", 30, 2);
  surface.destroy();
  expect(frames.size).toBe(0);
});

it("旋转先提交真实点，再调整坐标；后续旧手势不落墨", () => {
  send("pointerdown");
  send("pointermove", 30);
  const host = canvas.parentElement;
  if (!host) throw new Error("画布容器缺失");
  Object.defineProperty(host, "clientWidth", {
    value: 600,
    configurable: true,
  });
  resizeCallback?.();
  send("pointermove", 90);
  expect(points()[0]).toHaveLength(2);
});

it("笔已落屏时手掌触摸不引发滚动，纯手指触摸照常滚动", () => {
  const event = new Event("touchmove", { cancelable: true });
  Object.assign(event, {
    changedTouches: [{ touchType: "direct" }],
    touches: [{ touchType: "stylus" }, { touchType: "direct" }],
  });
  canvas.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const direct = new Event("touchmove", { cancelable: true });
  Object.assign(direct, {
    changedTouches: [{ touchType: "direct" }],
    touches: [{ touchType: "direct" }],
  });
  canvas.dispatchEvent(direct);
  expect(direct.defaultPrevented).toBe(false);
});
it("预测超时消失，导出与正文都不包含预测", async () => {
  vi.useFakeTimers();
  send("pointerdown");
  send("pointermove", 30, 1, 30, {
    getPredictedEvents: () => [
      { clientX: 40, clientY: 20, pressure: 0.5, timeStamp: 45 },
    ],
  });
  expect(surface.getStats().predictionPoints).toBe(1);
  vi.advanceTimersByTime(33);
  expect(surface.getStats().predictionPoints).toBe(0);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
    cb(new Blob(["png"], { type: "image/png" })),
  );
  await surface.exportPng();
  expect(points()[0]).toHaveLength(2);
  expect(surface.getStats().predictionPoints).toBe(0);
  vi.useRealTimers();
});
