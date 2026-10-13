import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: 500, configurable: true },
    clientHeight: { value: 400 },
  });
  document.body.append(host);
  surface = createFeelSurface({ ...DEFAULT_FEEL_PARAMS, prediction: true });
  surface.mount(host);
  const target = host.querySelector<HTMLCanvasElement>("[data-slot=feel-wet]");
  if (!target) throw new Error("实验画布未挂载");
  canvas = target;
});
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
