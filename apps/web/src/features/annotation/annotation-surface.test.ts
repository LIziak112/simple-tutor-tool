import type { AnnotationDoc } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOTATION_CANVAS_DATA_SLOT, createAnnotationSurface } from "./annotation-surface.ts";

/**
 * 标注画布适配器测试（T6R.20）：坐标域=底图像素（backing store 恒定、resize
 * 不重绘不漂移）、§4.1 输入状态机接线（第二指针/pointercancel/
 * lostpointercapture/失焦/布局变化按已收采样收笔）、**不依赖 event.target
 * 穿透**（中间层插入/事件目标被替换仍正确收点）、undo/redo/clear/load。
 * jsdom 无 canvas 2d——录制式桩（手法同 atrament-adapter.test.ts）。
 */

class StubContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  beginPath(): void {}
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  stroke(): void {}
  fillRect(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
}

class ResizeObserverStub {
  static readonly instances: ResizeObserverStub[] = [];
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let getContextSpy: ReturnType<typeof vi.spyOn>;

const BASE_W = 1440;
const BASE_H = 900;
/** 容器 CSS 盒（getBoundingClientRect 桩） */
const CSS_W = 648;
const CSS_H = 405;

const activeSurfaces: Array<{
  surface: ReturnType<typeof createAnnotationSurface>;
  container: HTMLDivElement;
}> = [];

beforeEach(() => {
  ResizeObserverStub.instances.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      return new StubContext() as unknown as CanvasRenderingContext2D;
    });
});

afterEach(() => {
  for (const h of activeSurfaces.splice(0)) {
    h.surface.destroy();
    h.container.remove();
  }
  getContextSpy.mockRestore();
  vi.unstubAllGlobals();
});

function mountSurface(initial?: AnnotationDoc): {
  surface: ReturnType<typeof createAnnotationSurface>;
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  events: Array<{ reason: string; strokes: number }>;
  triggerLayoutChange(): void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rect = { left: 100, top: 50, width: CSS_W, height: CSS_H, right: 100 + CSS_W, bottom: 50 + CSS_H } as DOMRect;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect);
  const surface = createAnnotationSurface({ baseWidth: BASE_W, baseHeight: BASE_H });
  surface.mount(container, initial);
  const canvas = container.querySelector(
    `canvas[data-slot="${ANNOTATION_CANVAS_DATA_SLOT}"]`,
  );
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("画布未挂载");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect);
  const events: Array<{ reason: string; strokes: number }> = [];
  surface.onChange((doc, reason) => {
    events.push({ reason, strokes: doc.strokes.length });
  });
  activeSurfaces.push({ surface, container });
  return {
    surface,
    container,
    canvas,
    events,
    triggerLayoutChange() {
      const last = ResizeObserverStub.instances.at(-1);
      if (!last) throw new Error("ResizeObserver 未创建");
      last.callback([], last);
    },
  };
}

function pointer(
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  opts: {
    pointerId?: number;
    pointerType?: string;
    clientX?: number;
    clientY?: number;
    buttons?: number;
  } = {},
): void {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: opts.pointerId ?? 1,
      pointerType: opts.pointerType ?? "pen",
      isPrimary: true,
      button: 0,
      buttons: opts.buttons ?? (type === "pointerup" ? 0 : 1),
      pressure: 0.5,
      clientX: opts.clientX ?? 120,
      clientY: opts.clientY ?? 70,
    }),
  );
}

/** CSS 页面坐标 → 底图像素（断言用，与实现同式） */
function toBase(cssX: number, cssY: number): { x: number; y: number } {
  return {
    x: Math.round(((cssX - 100) / CSS_W) * BASE_W * 100) / 100,
    y: Math.round(((cssY - 50) / CSS_H) * BASE_H * 100) / 100,
  };
}

function writeStroke(
  h: ReturnType<typeof mountSurface>,
  points: Array<{ x: number; y: number }>,
  opts: { pointerType?: string; pointerId?: number } = {},
): void {
  const { pointerType = "pen", pointerId = 1 } = opts;
  const first = points[0];
  if (!first) throw new Error("空笔画");
  pointer(h.canvas, "pointerdown", { pointerType, pointerId, ...first });
  for (const p of points.slice(1)) {
    pointer(h.canvas, "pointermove", { pointerType, pointerId, ...p });
  }
  pointer(h.canvas, "pointerup", { pointerType, pointerId, ...points.at(-1) });
}

describe("标注画布：坐标域与画布恒定", () => {
  it("backing store = 底图像素域；CSS 盒随容器（100%×aspect-ratio）", () => {
    const h = mountSurface();
    expect(h.canvas.width).toBe(BASE_W);
    expect(h.canvas.height).toBe(BASE_H);
    expect(h.canvas.style.width).toBe("100%");
    expect(h.container.style.aspectRatio).toBe(`${BASE_W} / ${BASE_H}`);
  });

  it("收点在底图像素域（CSS→base 换算，2 位小数）；weight 同域", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 200, y: 90 },
      { x: 280, y: 110 },
    ]);
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    const first = strokes[0]?.points[0];
    const expected = toBase(120, 70);
    expect(first?.x).toBeCloseTo(expected.x, 1);
    expect(first?.y).toBeCloseTo(expected.y, 1);
    // 笔粗换算到底图域（medium=4 逻辑 → 4×1440/1000=5.76）
    expect(strokes[0]?.weight).toBe(5.76);
    // doc 几何即底图几何（服务端校验一致）
    expect(h.surface.getDoc().baseWidth).toBe(BASE_W);
    expect(h.surface.getDoc().baseHeight).toBe(BASE_H);
  });

  it("resize/旋转（布局变化）：位图不重设、在途一笔按已收采样收笔、后续照常", () => {
    const h = mountSurface();
    // 落笔后布局变化（收笔不含布局变化后的事件点）
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 180, clientY: 90 });
    h.triggerLayoutChange();
    pointer(h.canvas, "pointermove", { clientX: 300, clientY: 200 }); // 旧手势后续采样：丢弃
    pointer(h.canvas, "pointerup", { clientX: 300, clientY: 200 });
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    // 只含布局变化前的两个采样（不补造终点）
    expect(strokes[0]?.points).toHaveLength(2);
    // 位图未重设（恒定 backing store）
    expect(h.canvas.width).toBe(BASE_W);
    // 新一笔照常（新坐标基准）
    writeStroke(h, [
      { x: 200, y: 100 },
      { x: 240, y: 120 },
    ]);
    expect(h.surface.getDoc().strokes).toHaveLength(2);
  });
});

describe("标注画布：§4.1 输入状态机接线", () => {
  it("第二指针到达（自愈兜底语义）：在途笔按已收采样先行收笔，两笔不混点", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { pointerId: 1, clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { pointerId: 1, clientX: 170, clientY: 85 });
    // 第二 pointerdown＝自愈兜底（丢 up 的畸形序列）：先收笔再开新笔——
    // 旧手势后续采样不混入新笔（§4.1「一笔不混两个来源的采样」）
    pointer(h.canvas, "pointerdown", { pointerId: 2, clientX: 400, clientY: 300 });
    pointer(h.canvas, "pointermove", { pointerId: 1, clientX: 190, clientY: 90 });
    pointer(h.canvas, "pointermove", { pointerId: 2, clientX: 420, clientY: 310 });
    pointer(h.canvas, "pointerup", { pointerId: 2, clientX: 420, clientY: 310 });
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(2);
    expect(strokes[0]?.points).toHaveLength(2); // 第一笔只含已收采样
    expect(strokes[1]?.points).toHaveLength(2); // 第二笔只含指针 2 的采样
    const mixed = strokes[1]?.points.find((p) => p.x < 400);
    expect(mixed).toBeUndefined();
  });

  it("pointercancel：按已收真实采样收笔（不补造终点）", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 170, clientY: 85 });
    pointer(h.canvas, "pointercancel", { clientX: 0, clientY: 0 });
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.points).toHaveLength(2); // 不含 cancel 事件坐标
    const last = strokes[0]?.points.at(-1);
    const expected = toBase(170, 85);
    expect(last?.x).toBeCloseTo(expected.x, 1);
  });

  it("lostpointercapture：同口径收笔", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 170, clientY: 85 });
    h.canvas.dispatchEvent(
      new PointerEvent("lostpointercapture", {
        bubbles: true,
        pointerId: 1,
        pointerType: "pen",
      }),
    );
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });

  it("窗口失焦：在途笔按已收采样收笔", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    window.dispatchEvent(new Event("blur"));
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });
});

describe("标注画布：不依赖 event.target 穿透", () => {
  it("中间层插入（画布与指针间叠加层）：画布自身监听仍收点", () => {
    const h = mountSurface();
    // 在画布上方插入覆盖层（视觉叠加，如高亮提示层）——事件若靠
    // event.target.closest 定位宿主会被遮挡打断；实现直接绑画布元素
    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    h.container.appendChild(overlay);
    // 事件仍派发到画布（pointer-events 让 overlay 不拦截时，画布是目标）
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 160, y: 80 },
    ]);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    overlay.remove();
  });

  it("事件目标被替换（e.target 指向被换掉的节点）：仍按画布 rect 收点", () => {
    const h = mountSurface();
    // 构造 e.target 被替换的事件（jsdom dispatch 时 target 不可改，用
    // capture 到的坐标路径验证：坐标取 clientX/Y + 画布 rect，不读 target）
    const ev = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons: 1,
      pressure: 0.5,
      clientX: 200,
      clientY: 100,
    });
    // 人为把 target 抹掉（模拟事件宿主被替换/移除后的派发残骸）
    Object.defineProperty(ev, "target", { value: null });
    h.canvas.dispatchEvent(ev);
    const move = new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons: 1,
      pressure: 0.5,
      clientX: 240,
      clientY: 120,
    });
    Object.defineProperty(move, "target", { value: null });
    h.canvas.dispatchEvent(move);
    const up = new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons: 0,
      pressure: 0.5,
      clientX: 240,
      clientY: 120,
    });
    Object.defineProperty(up, "target", { value: null });
    h.canvas.dispatchEvent(up);
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    const expected = toBase(200, 100);
    expect(strokes[0]?.points[0]?.x).toBeCloseTo(expected.x, 1);
  });
});

describe("标注画布：历史与工具", () => {
  it("undo/redo/clear 与 reason 分型；load 外部文档替换", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 160, y: 80 },
    ]);
    expect(h.events.at(-1)?.reason).toBe("stroke");
    h.surface.undo();
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    expect(h.events.at(-1)?.reason).toBe("undo");
    expect(h.surface.canUndo()).toBe(false);
    expect(h.surface.canRedo()).toBe(true);
    h.surface.redo();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    h.surface.clear();
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    expect(h.events.at(-1)?.reason).toBe("clear");
    const external: AnnotationDoc = {
      version: 1,
      baseWidth: BASE_W,
      baseHeight: BASE_H,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 5.76,
          points: [{ x: 10, y: 10, p: 0.5, t: 0 }],
        },
      ],
    };
    h.surface.load(external);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(h.events.at(-1)?.reason).toBe("load");
  });

  it("橡皮：整笔删除（拖动命中合并为一个 erase 历史）", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 160, y: 80 },
    ]);
    h.surface.setTool({ type: "eraser" });
    // 在第一笔附近拖动（橡皮半径 14×1.44=20.16 底图像素）
    pointer(h.canvas, "pointerdown", { clientX: 125, clientY: 72 });
    pointer(h.canvas, "pointermove", { clientX: 155, clientY: 79 });
    pointer(h.canvas, "pointerup", { clientX: 155, clientY: 79 });
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    expect(h.events.some((e) => e.reason === "erase")).toBe(true);
  });

  it("初始文档（恢复笔迹）随挂载载入", () => {
    const initial: AnnotationDoc = {
      version: 1,
      baseWidth: BASE_W,
      baseHeight: BASE_H,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 5.76,
          points: [
            { x: 100, y: 100, p: 0.5, t: 0 },
            { x: 200, y: 120, p: 0.5, t: 16 },
          ],
        },
      ],
    };
    const h = mountSurface(initial);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });
});
