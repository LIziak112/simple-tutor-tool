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
