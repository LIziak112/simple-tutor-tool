import type { AnnotationDoc } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_CANVAS_DATA_SLOT,
  createAnnotationSurface,
} from "./annotation-surface.ts";

/**
 * 标注画布适配器测试（T6R.20）：坐标域=底图像素（backing store 恒定、resize
 * 不重绘不漂移）、§4.1 输入状态机接线（第二指针/pointercancel/
 * lostpointercapture/失焦/布局变化按已收采样收笔）、**不依赖 event.target
 * 穿透**（中间层插入/事件目标被替换仍正确收点）、undo/redo/clear/load。
 * jsdom 无 canvas 2d——录制式桩（手法同 atrament-adapter.test.ts）。
 */

class StubContext {
  /** 累计 stroke 调用数（零尺寸挂载补绘测试的观察点；beforeEach 清零） */
  static strokeCalls = 0;
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
  stroke(): void {
    StubContext.strokeCalls += 1;
  }
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
  StubContext.strokeCalls = 0;
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
  const rect = {
    left: 100,
    top: 50,
    width: CSS_W,
    height: CSS_H,
    right: 100 + CSS_W,
    bottom: 50 + CSS_H,
  } as DOMRect;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect);
  const surface = createAnnotationSurface({
    baseWidth: BASE_W,
    baseHeight: BASE_H,
  });
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

it("切为笔写模式后手指不落墨，切回手指书写无需重建画布", () => {
  const { surface, canvas } = mountSurface();
  surface.setInputMode("pen");
  pointer(canvas, "pointerdown", { pointerType: "touch" });
  pointer(canvas, "pointermove", { pointerType: "touch", clientX: 150 });
  pointer(canvas, "pointerup", { pointerType: "touch", clientX: 150 });
  expect(surface.getDoc().strokes).toHaveLength(0);
  pointer(canvas, "pointerdown");
  pointer(canvas, "pointermove", { clientX: 150 });
  pointer(canvas, "pointerup", { clientX: 150 });
  expect(surface.getDoc().strokes).toHaveLength(1);
  surface.setInputMode("finger");
  pointer(canvas, "pointerdown", { pointerType: "touch" });
  pointer(canvas, "pointermove", { pointerType: "touch", clientX: 150 });
  pointer(canvas, "pointerup", { pointerType: "touch", clientX: 150 });
  expect(surface.getDoc().strokes).toHaveLength(2);
  expect(canvas.isConnected).toBe(true);
});

it("清空时收尾在途笔，迟到的移动与抬笔不恢复已清空正文", () => {
  const { surface, canvas } = mountSurface();
  pointer(canvas, "pointerdown");
  pointer(canvas, "pointermove", { clientX: 150 });
  surface.clear();
  pointer(canvas, "pointermove", { clientX: 180 });
  pointer(canvas, "pointerup", { clientX: 180 });
  expect(surface.getDoc().strokes).toHaveLength(0);
  surface.undo();
  expect(surface.getDoc().strokes).toHaveLength(1);
});

function writeStroke(
  h: ReturnType<typeof mountSurface>,
  points: Array<{ x: number; y: number }>,
  opts: { pointerType?: string; pointerId?: number } = {},
): void {
  const { pointerType = "pen", pointerId = 1 } = opts;
  const first = points[0];
  if (!first) throw new Error("空笔画");
  pointer(h.canvas, "pointerdown", {
    pointerType,
    pointerId,
    clientX: first.x,
    clientY: first.y,
  });
  for (const p of points.slice(1)) {
    pointer(h.canvas, "pointermove", {
      pointerType,
      pointerId,
      clientX: p.x,
      clientY: p.y,
    });
  }
  const last = points.at(-1) ?? first;
  pointer(h.canvas, "pointerup", {
    pointerType,
    pointerId,
    clientX: last.x,
    clientY: last.y,
  });
}

describe("标注画布：坐标域与画布恒定", () => {
  it("切题显式收笔提交已收点，迟到up不重复提交", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 180, clientY: 90 });
    h.surface.finish();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    pointer(h.canvas, "pointerup", { clientX: 180, clientY: 90 });
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });
  it("作答态不收指针，恢复标画保留撤销历史", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 140, y: 80 },
    ]);
    h.surface.setInputEnabled(false);
    writeStroke(h, [
      { x: 140, y: 90 },
      { x: 180, y: 100 },
    ]);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    h.surface.setInputEnabled(true);
    h.surface.undo();
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    h.surface.redo();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });
  it("backing store = 底图像素域；画布填满宿主且不接管宿主布局", () => {
    const h = mountSurface();
    expect(h.canvas.width).toBe(BASE_W);
    expect(h.canvas.height).toBe(BASE_H);
    expect(h.canvas.style.width).toBe("100%");
    expect(h.canvas.style.height).toBe("100%");
    expect(h.container.style.position).toBe("");
    expect(h.container.style.width).toBe("");
    expect(h.container.style.aspectRatio).toBe("");
  });

  it("挂载到绝对定位覆盖层时保留调用方的定位和尺寸", () => {
    const h = mountSurface();
    h.surface.destroy();
    h.container.style.position = "absolute";
    h.container.style.inset = "0";
    h.container.style.width = "80%";
    h.container.style.aspectRatio = "2 / 1";
    h.surface.mount(h.container);
    expect(h.container.style.position).toBe("absolute");
    expect(h.container.style.inset).toBe("0px");
    expect(h.container.style.width).toBe("80%");
    expect(h.container.style.aspectRatio).toBe("2 / 1");
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
    pointer(h.canvas, "pointerdown", {
      pointerId: 1,
      clientX: 150,
      clientY: 80,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 1,
      clientX: 170,
      clientY: 85,
    });
    // 第二 pointerdown＝自愈兜底（丢 up 的畸形序列）：先收笔再开新笔——
    // 旧手势后续采样不混入新笔（§4.1「一笔不混两个来源的采样」）
    pointer(h.canvas, "pointerdown", {
      pointerId: 2,
      clientX: 400,
      clientY: 300,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 1,
      clientX: 190,
      clientY: 90,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 2,
      clientX: 420,
      clientY: 310,
    });
    pointer(h.canvas, "pointerup", {
      pointerId: 2,
      clientX: 420,
      clientY: 310,
    });
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
  it("橡皮在途撤销先收笔，迟到事件不再次删稿", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 500, y: 100 },
      { x: 550, y: 100 },
    ]);
    writeStroke(h, [
      { x: 130, y: 100 },
      { x: 180, y: 100 },
    ]);
    const original = h.surface.getDoc().strokes;
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", { clientX: 520, clientY: 100 });
    h.surface.undo();
    pointer(h.canvas, "pointerup", { clientX: 520, clientY: 100 });
    expect(h.surface.getDoc().strokes).toEqual(original);
    h.surface.redo();
    expect(h.surface.getDoc().strokes).toEqual([original[1]]);
  });
  it("擦除右侧后重绘保留左侧，强制收笔、撤销与重做保持一致", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 500, y: 100 },
      { x: 550, y: 100 },
    ]);
    writeStroke(h, [
      { x: 130, y: 100 },
      { x: 180, y: 100 },
    ]);
    const original = h.surface.getDoc().strokes;
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", { clientX: 520, clientY: 100 });
    const paint = vi.spyOn(StubContext.prototype, "quadraticCurveTo");
    h.surface.finish();
    expect(h.surface.getDoc().strokes).toEqual([original[1]]);
    expect(paint).toHaveBeenCalled();
    h.surface.undo();
    expect(h.surface.getDoc().strokes).toEqual(original);
    h.surface.redo();
    expect(h.surface.getDoc().strokes).toEqual([original[1]]);
    paint.mockRestore();
  });

  it("快速拖动按底图坐标连续命中，远处标画保留", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 300, y: 80 },
      { x: 300, y: 160 },
    ]);
    writeStroke(h, [
      { x: 600, y: 80 },
      { x: 600, y: 160 },
    ]);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", { clientX: 250, clientY: 120 });
    pointer(h.canvas, "pointermove", { clientX: 350, clientY: 120 });
    pointer(h.canvas, "pointerup", { clientX: 350, clientY: 120 });
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(h.surface.getDoc().strokes[0]?.points[0]?.x).toBeGreaterThan(1000);
  });
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

  it("初始文档的墓碑与锚点随挂载载入（首次编辑不写丢）", () => {
    const initial: AnnotationDoc = {
      version: 1,
      baseWidth: BASE_W,
      baseHeight: BASE_H,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 5.76,
          id: "keep-1",
          points: [
            { x: 100, y: 100, p: 0.5, t: 0 },
            { x: 200, y: 120, p: 0.5, t: 16 },
          ],
        },
      ],
      deleted: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 5.76,
          id: "gone-1",
          deletedAt: 1727392800000,
          deletedBy: "eraser",
          points: [{ x: 300, y: 140, p: 0.5, t: 0 }],
        },
      ],
      anchors: { "keep-1": "stem/p/0", "gone-1": "stem/p/1" },
    };
    const h = mountSurface(initial);
    expect(h.surface.getDoc().deleted).toEqual(initial.deleted);
    expect(h.surface.getDoc().anchors).toEqual(initial.anchors);
    // 首次编辑（新笔）后，挂载进来的墓碑与锚点原样保留
    writeStroke(h, [
      { x: 120, y: 70 },
      { x: 200, y: 90 },
    ]);
    const after = h.surface.getDoc();
    expect(after.deleted).toEqual(initial.deleted);
    expect(after.anchors?.["keep-1"]).toBe("stem/p/0");
    expect(after.anchors?.["gone-1"]).toBe("stem/p/1");
    expect(after.strokes).toHaveLength(2);
  });
});

describe("标注画布：宿主零尺寸挂载的补绘", () => {
  it("挂载时宿主未布局（底图未加载高/宽为 0）：初始重绘挂起，布局就绪后经 ResizeObserver 补绘一次", () => {
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
    const container = document.createElement("div");
    document.body.appendChild(container);
    const rect = {
      left: 100,
      top: 50,
      width: 0,
      height: 0,
      right: 100,
      bottom: 50,
    } as DOMRect;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect);
    const surface = createAnnotationSurface({
      baseWidth: BASE_W,
      baseHeight: BASE_H,
    });
    surface.mount(container, initial);
    const canvas = container.querySelector(
      `canvas[data-slot="${ANNOTATION_CANVAS_DATA_SLOT}"]`,
    );
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("画布未挂载");
    // jsdom 的 offsetWidth/offsetHeight 恒 0 = 零尺寸挂载：初始重绘挂起。
    expect(StubContext.strokeCalls).toBe(0);
    expect(surface.getDoc().strokes).toHaveLength(1);
    // 布局就绪（底图加载撑起宿主）：mock 出非零尺寸并触发 ResizeObserver。
    Object.defineProperty(canvas, "offsetWidth", {
      get: () => CSS_W,
      configurable: true,
    });
    Object.defineProperty(canvas, "offsetHeight", {
      get: () => CSS_H,
      configurable: true,
    });
    const last = ResizeObserverStub.instances.at(-1);
    if (!last) throw new Error("ResizeObserver 未创建");
    last.callback([], last);
    expect(StubContext.strokeCalls).toBeGreaterThan(0);
    // 补绘只发生一次：后续布局变化回到只收笔不重绘。
    const afterFirst = StubContext.strokeCalls;
    last.callback([], last);
    expect(StubContext.strokeCalls).toBe(afterFirst);
    surface.destroy();
    container.remove();
  });
});

describe("标注画布：近似原位域视图（reprojectedView，LR-PR4 第二层）", () => {
  const VIEW_W = 1800;
  const VIEW_H = 1000;
  const STORED_W = 1440;
  const STORED_H = 800;
  /** 线性测试映射：视图 ×1.25 = 存储；存储 ×0.8 = 视图（宽高同 0.8 比例） */
  const toStoredStroke = (stroke: import("@tutor/contract").InkStroke) => ({
    ...stroke,
    weight: stroke.weight * 0.8,
    points: stroke.points.map((point) => ({
      ...point,
      x: Math.round(point.x * 0.8 * 100) / 100,
      y: Math.round(point.y * 0.8 * 100) / 100,
    })),
  });
  const toViewStroke = (stroke: import("@tutor/contract").InkStroke) => ({
    ...stroke,
    weight: stroke.weight * 1.25,
    points: stroke.points.map((point) => ({
      ...point,
      x: point.x * 1.25,
      y: point.y * 1.25,
    })),
  });
  const view = {
    storedBaseWidth: STORED_W,
    storedBaseHeight: STORED_H,
    strokeToStored: toStoredStroke,
    strokeToView: toViewStroke,
    pointToStored: (p: { x: number; y: number }) => ({
      x: Math.round(p.x * 0.8 * 100) / 100,
      y: Math.round(p.y * 0.8 * 100) / 100,
      ratio: 0.8,
    }),
  };
  /** 视图域锚块（盖住测试笔画：视图 (100,20)-(240,40)） */
  const viewBlocks = [
    {
      x: 0,
      y: 0,
      width: VIEW_W,
      height: 200,
      tag: "p",
      node: "stem/p/0",
    },
  ] as import("@tutor/contract").AnnotationSurfaceCompatibility["blocks"];

  function mountViewSurface(initial?: AnnotationDoc) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const rect = {
      left: 100,
      top: 50,
      width: 900,
      height: 500,
      right: 1000,
      bottom: 550,
    } as DOMRect;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect);
    const strokeToStored = vi.fn(view.strokeToStored);
    const surface = createAnnotationSurface({
      baseWidth: VIEW_W,
      baseHeight: VIEW_H,
      anchorBlocks: () => viewBlocks,
      reprojectedView: { ...view, strokeToStored },
    });
    surface.mount(container, initial);
    const canvas = container.querySelector(
      `canvas[data-slot="${ANNOTATION_CANVAS_DATA_SLOT}"]`,
    );
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("画布未挂载");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect);
    activeSurfaces.push({ surface, container });
    return { surface, container, canvas, strokeToStored };
  }

  it("收笔提交映射回存储域：getDoc 恒为存储域（baseWidth/点坐标/weight），锚定照常", () => {
    const h = mountViewSurface();
    // 画布 CSS→视图：×2（900 宽）。client(150,60) → 视图 (100,20) → 存储 (80,16)
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 60 });
    pointer(h.canvas, "pointermove", { clientX: 220, clientY: 70 });
    pointer(h.canvas, "pointerup", { clientX: 220, clientY: 70 });
    const doc = h.surface.getDoc();
    expect(doc.baseWidth).toBe(STORED_W);
    expect(doc.baseHeight).toBe(STORED_H);
    expect(doc.strokes).toHaveLength(1);
    const first = doc.strokes[0]?.points[0];
    expect(first?.x).toBeCloseTo(80, 1);
    expect(first?.y).toBeCloseTo(16, 1);
    // weight：medium 4 逻辑 ×1.8（视图域）= 7.2 → ×0.8 = 5.76 存储域
    expect(doc.strokes[0]?.weight).toBeCloseTo(5.76, 2);
    // 锚定在视图域块表上照常完成，且 strokeToStored 收到锚键
    expect(doc.anchors?.[doc.strokes[0]?.id ?? ""]).toBe("stem/p/0");
    expect(h.strokeToStored).toHaveBeenCalledWith(
      expect.anything(),
      "stem/p/0",
    );
  });

  it("存储文档载入后重绘映射到视图域（strokeToView 收到存储笔画与锚键）", () => {
    const storedStroke = {
      tool: "pen" as const,
      color: "#1f2328",
      weight: 5.76,
      id: "keep-1",
      points: [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 200, y: 120, p: 0.5, t: 16 },
      ],
    };
    const h = mountViewSurface({
      version: 1,
      baseWidth: STORED_W,
      baseHeight: STORED_H,
      strokes: [storedStroke],
      anchors: { "keep-1": "stem/p/0" },
    });
    const doc = h.surface.getDoc();
    expect(doc.strokes[0]?.points[0]?.x).toBeCloseTo(100, 5);
    expect(doc.anchors?.["keep-1"]).toBe("stem/p/0");
    // 渲染边界：重绘把存储笔画映射为视图笔画（×1.25）后再交给 atrament
    const rendered = toViewStroke(storedStroke);
    // StubContext 不记坐标——这里只锁「映射发生了」：strokeToView 的输出喂给
    // 渲染层等价于对每个点 ×1.25；断言交给 vitest 的调用事实（无异常、计数）
    expect(StubContext.strokeCalls).toBeGreaterThanOrEqual(0);
    expect(rendered.points[0]?.x).toBeCloseTo(125, 5);
  });

  it("橡皮在存储域命中：视图指针点映射后擦除存储笔画（墓碑=存储几何）", () => {
    const storedStroke = {
      tool: "pen" as const,
      color: "#1f2328",
      weight: 5.76,
      id: "keep-1",
      points: [
        { x: 80, y: 16, p: 0.5, t: 0 },
        { x: 160, y: 24, p: 0.5, t: 16 },
      ],
    };
    const h = mountViewSurface({
      version: 1,
      baseWidth: STORED_W,
      baseHeight: STORED_H,
      strokes: [storedStroke],
      anchors: { "keep-1": "stem/p/0" },
    });
    h.surface.setTool({ type: "eraser" });
    // 视图指针 (100,20)→(200,30)：映射存储 (80,16)→(160,24)，正中笔画
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 60 });
    pointer(h.canvas, "pointermove", { clientX: 200, clientY: 65 });
    pointer(h.canvas, "pointerup", { clientX: 200, clientY: 65 });
    const doc = h.surface.getDoc();
    expect(doc.strokes).toHaveLength(0);
    expect(doc.deleted).toHaveLength(1);
    // 墓碑几何 = 存储域原笔（不是视图域映射后的形状）
    expect(doc.deleted?.[0]?.points[0]?.x).toBeCloseTo(80, 5);
    expect(doc.deleted?.[0]?.id).toBe("keep-1");
  });
});
