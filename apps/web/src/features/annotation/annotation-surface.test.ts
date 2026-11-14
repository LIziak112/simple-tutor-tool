import type { AnnotationDoc } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onePathSvg } from "@/features/ink/engine/highlighter-paint.ts";
import {
  INK_ERASER_RING_SELECTOR,
  INK_LIVE_LAYER_SELECTOR,
} from "@/features/ink/engine/live-layer.ts";
import { INK_HIGHLIGHTER_COLORS } from "@/features/ink/engine/types.ts";
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
  lineTo(): void {}
  quadraticCurveTo(): void {}
  arc(): void {}
  closePath(): void {}
  stroke(): void {
    StubContext.strokeCalls += 1;
  }
  fill(): void {}
  fillRect(): void {}
  clearRect(): void {}
  rect(): void {}
  clip(): void {}
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
  it("输入变只读时先按已收采样收笔，再解绑指针", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 180, clientY: 90 });
    h.surface.setInputEnabled(false);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(h.events.at(-1)).toEqual({ reason: "stroke", strokes: 1 });
    expect(h.canvas.dataset.inputEnabled).toBe("false");
    pointer(h.canvas, "pointermove", { clientX: 190, clientY: 100 });
    pointer(h.canvas, "pointerup", { clientX: 190, clientY: 100 });
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });
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

  it("橡皮大小决定命中范围（小 11.52 / 中 20.16 / 大 34.56 底图像素，另加半笔宽 2.88）", () => {
    const h = mountSurface();
    // 横线 y=70；1 CSS px = 2.22 底图像素
    const line = [
      { x: 150, y: 70 },
      { x: 250, y: 70 },
    ];
    const tapAt = (y: number) => {
      pointer(h.canvas, "pointerdown", { clientX: 200, clientY: y });
      pointer(h.canvas, "pointerup", { clientX: 200, clientY: y });
    };
    writeStroke(h, line);
    // 离线 8px = 17.8 底图像素：小号 14.4 够不着，中号 23.04 够得着
    h.surface.setTool({ type: "eraser", size: "small" });
    tapAt(78);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    h.surface.setTool({ type: "eraser", size: "medium" });
    tapAt(78);
    expect(h.surface.getDoc().strokes).toHaveLength(0);

    h.surface.setTool({ type: "pen" });
    writeStroke(h, line);
    // 离线 12px = 26.7 底图像素：缺省中号够不着，大号 37.44 够得着
    h.surface.setTool({ type: "eraser" });
    tapAt(82);
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    h.surface.setTool({ type: "eraser", size: "large" });
    tapAt(82);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
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
    strokeToStored: (stroke: import("@tutor/contract").InkStroke) => ({
      stroke: toStoredStroke(stroke),
      unanchored: false,
    }),
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
    const strokeToView = vi.fn(view.strokeToView);
    const surface = createAnnotationSurface({
      baseWidth: VIEW_W,
      baseHeight: VIEW_H,
      anchorBlocks: () => viewBlocks,
      reprojectedView: { ...view, strokeToStored, strokeToView },
    });
    surface.mount(container, initial);
    const canvas = container.querySelector(
      `canvas[data-slot="${ANNOTATION_CANVAS_DATA_SLOT}"]`,
    );
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("画布未挂载");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect);
    activeSurfaces.push({ surface, container });
    return { surface, container, canvas, strokeToStored, strokeToView };
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
    // jsdom 零尺寸挂载时初始重绘挂起（见上方用例）：经 load 触发一次重绘
    h.surface.load(doc);
    // 渲染边界：重绘把存储笔画连同锚键交给 strokeToView（去掉垫片即红）
    expect(h.strokeToView).toHaveBeenCalledWith(
      expect.objectContaining({ id: "keep-1" }),
      "stem/p/0",
    );
    expect(h.strokeToView).toHaveReturnedWith(
      expect.objectContaining({
        points: [
          expect.objectContaining({ x: 125, y: 125 }),
          expect.objectContaining({ x: 250, y: 150 }),
        ],
      }),
    );
  });

  it("映射走 root 兜底（unanchored）时不写 anchors——服务端锚校验防 400", () => {
    const h = mountViewSurface();
    h.strokeToStored.mockImplementation(
      (stroke: import("@tutor/contract").InkStroke) => ({
        stroke: toStoredStroke(stroke),
        unanchored: true,
      }),
    );
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 60 });
    pointer(h.canvas, "pointermove", { clientX: 220, clientY: 70 });
    pointer(h.canvas, "pointerup", { clientX: 220, clientY: 70 });
    const doc = h.surface.getDoc();
    expect(doc.strokes).toHaveLength(1);
    // 几何照常落存储域（root 兜底），只是不带锚
    expect(doc.strokes[0]?.points[0]?.x).toBeCloseTo(80, 1);
    expect(doc.anchors).toBeUndefined();
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

  it("局部橡皮也在存储域切：段沿用原笔画的锚点，预览与重绘都按这个锚映射；整张重画、橡皮圈在视图域", () => {
    const h = mountViewSurface({
      version: 1,
      baseWidth: STORED_W,
      baseHeight: STORED_H,
      strokes: [
        {
          tool: "pen" as const,
          color: "#1f2328",
          weight: 5.76,
          id: "keep-1",
          points: [
            { x: 80, y: 16, p: 0.5, t: 0 },
            { x: 160, y: 24, p: 0.5, t: 16 },
          ],
        },
      ],
      anchors: { "keep-1": "stem/p/0" },
    });
    h.surface.setTool({ type: "eraser", mode: "partial", size: "small" });
    h.strokeToView.mockClear();
    const clip = vi.spyOn(StubContext.prototype, "clip");
    // 视图指针 (150,25) → 存储 (120,20)，正好是笔画中点；小号橡皮视图半径
    // 14.4 → 存储 11.52，加半笔宽 2.88，沿笔画各切掉 14.4
    pointer(h.canvas, "pointerdown", { clientX: 175, clientY: 62.5 });
    // 拖动途中的预览：两段都按原笔画的锚映射到视图；不做局部重画
    expect(h.strokeToView).toHaveBeenCalledTimes(2);
    for (const nth of [1, 2]) {
      expect(h.strokeToView).toHaveBeenNthCalledWith(
        nth,
        expect.objectContaining({ tool: "pen" }),
        "stem/p/0",
      );
    }
    expect(clip).not.toHaveBeenCalled();
    clip.mockRestore();
    const ring = h.container.querySelector(INK_ERASER_RING_SELECTOR);
    expect(
      ["cx", "cy", "r"].map((name) => Number(ring?.getAttribute(name))),
    ).toEqual([150, 25, 14.4]);

    pointer(h.canvas, "pointerup", { clientX: 175, clientY: 62.5 });
    const doc = h.surface.getDoc();
    expect(doc.strokes).toHaveLength(2);
    const [head, tail] = doc.strokes;
    expect(head?.points.at(-1)?.x).toBeCloseTo(105.67, 1);
    expect(head?.points.at(-1)?.y).toBeCloseTo(18.57, 1);
    expect(tail?.points[0]?.x).toBeCloseTo(134.33, 1);
    expect(tail?.points[0]?.y).toBeCloseTo(21.43, 1);
    expect(doc.anchors).toEqual({
      "keep-1": "stem/p/0",
      [head?.id ?? ""]: "stem/p/0",
      [tail?.id ?? ""]: "stem/p/0",
    });
    // 提交后的重绘：段带着自己的 id 与锚键
    expect(h.strokeToView).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: tail?.id }),
      "stem/p/0",
    );
  });

  it("图形在视图域成形（预览、间距、线宽都按当前画布），收笔整笔映射回存储域并照常锚定", () => {
    const h = mountViewSurface();
    h.surface.setTool({ type: "shape", shape: "line" });
    // 画布 CSS→视图：×2。client(150,60) → 视图 (100,20)；client(250,62) → 视图 (300,24)
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 60 });
    pointer(h.canvas, "pointermove", { clientX: 250, clientY: 62 });
    const path = h.container.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
    // 接近水平：吸附；预览在视图域
    expect(path?.getAttribute("d")).toBe("M100 20L300 20");
    pointer(h.canvas, "pointerup", { clientX: 250, clientY: 62 });
    // 交给映射的是视图域的整笔：间距 4 逻辑单位 × 1.8 = 7.2 视图像素
    const raw = h.strokeToStored.mock.lastCall?.[0];
    expect(raw?.points[0]).toMatchObject({ x: 100, y: 20 });
    expect(raw?.points.at(-1)).toMatchObject({ x: 300, y: 20 });
    expect(raw?.points[1]?.x).toBeCloseTo(107.14, 2);
    expect(h.strokeToStored).toHaveBeenLastCalledWith(
      expect.anything(),
      "stem/p/0",
    );
    const doc = h.surface.getDoc();
    expect(doc.strokes).toHaveLength(1);
    expect(doc.strokes[0]?.points[0]).toMatchObject({ x: 80, y: 16 });
    expect(doc.strokes[0]?.points.at(-1)).toMatchObject({ x: 240, y: 16 });
    expect(doc.anchors?.[doc.strokes[0]?.id ?? ""]).toBe("stem/p/0");
  });
});

describe("标注画布：图形与直线荧光笔", () => {
  function livePath(h: ReturnType<typeof mountSurface>): Element {
    const path = h.container.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
    if (path === null) throw new Error("临时层未挂载");
    return path;
  }
  /** 红色细笔的矩形：线宽 2.5 逻辑单位 → 底图像素域 3.6 */
  const RED_THIN_RECT = {
    type: "shape",
    shape: "rect",
    color: "red",
    size: "thin",
  } as const;
  /** client(190,95) → 底图 (200,100)；client(460,230) → 底图 (800,400) */
  const FROM = { x: 190, y: 95 };
  const TO = { x: 460, y: 230 };

  it("拖动途中只在临时层上出预览（底图像素域），不往画布上画，文档不变", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    pointer(h.canvas, "pointerdown", { clientX: FROM.x, clientY: FROM.y });
    pointer(h.canvas, "pointermove", { clientX: TO.x, clientY: TO.y });
    const path = livePath(h);
    expect(path.getAttribute("d")).toBe(
      "M200 100L800 100L800 400L200 400L200 100",
    );
    expect(path.getAttribute("stroke")).toBe("#dc2626");
    expect(path.getAttribute("stroke-width")).toBe("3.6");
    expect(StubContext.strokeCalls).toBe(0);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("抬笔：落成一笔普通的笔（点都在图形上，间距按底图宽度换算），画到画布，预览收起", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    writeStroke(h, [FROM, TO]);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    const stroke = strokes[0];
    expect(stroke).toMatchObject({
      tool: "pen",
      color: "#dc2626",
      weight: 3.6,
      pointer: "pen",
    });
    expect(stroke?.id).toEqual(expect.any(String));
    expect(stroke?.points[0]).toMatchObject({ x: 200, y: 100, p: 0.51, t: 0 });
    expect(stroke?.points.at(-1)).toMatchObject({ x: 200, y: 100 });
    // 周长 1800 底图像素、间距 4 × 1.44 = 5.76：105 + 53 + 105 + 53 步，
    // 连起点和四个角各补的一个点共 321 点
    expect(stroke?.points).toHaveLength(321);
    for (const p of stroke?.points ?? []) {
      expect(p.x === 200 || p.x === 800 || p.y === 100 || p.y === 400).toBe(
        true,
      );
    }
    expect(StubContext.strokeCalls).toBeGreaterThan(0);
    expect(h.events).toEqual([{ reason: "stroke", strokes: 1 }]);
    h.surface.undo();
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    h.surface.redo();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
  });

  it("只点一下或拖得太短：不落笔，不发变更", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    writeStroke(h, [FROM]);
    writeStroke(h, [FROM, { x: FROM.x + 3, y: FROM.y }]);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    expect(h.surface.canUndo()).toBe(false);
  });

  it("拖出画布：点不出底图范围（箭翼也收在边上）", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "arrow" });
    // 贴着上边往右画，再拖出右边界
    writeStroke(h, [
      { x: 400, y: 51 },
      { x: 900, y: 51 },
    ]);
    const points = h.surface.getDoc().strokes[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    expect(Math.max(...points.map((p) => p.x))).toBe(BASE_W);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(BASE_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(BASE_H);
    }
  });

  it("手掌先落、笔后落：手掌拖出的图形丢弃；布局变化：在途图形按拖到的位置落笔", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    pointer(h.canvas, "pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: FROM.x,
      clientY: FROM.y,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 1,
      pointerType: "touch",
      clientX: TO.x,
      clientY: TO.y,
    });
    expect(livePath(h).hasAttribute("d")).toBe(true);
    pointer(h.canvas, "pointerdown", {
      pointerId: 2,
      pointerType: "pen",
      clientX: FROM.x,
      clientY: FROM.y,
    });
    expect(livePath(h).hasAttribute("d")).toBe(false);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    pointer(h.canvas, "pointermove", {
      pointerId: 2,
      clientX: TO.x,
      clientY: TO.y,
    });
    h.triggerLayoutChange();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("直线荧光笔：预览和落笔都是一条直线，落成只有起止两点的荧光笔笔画", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter", straight: true });
    pointer(h.canvas, "pointerdown", { clientX: FROM.x, clientY: FROM.y });
    // 接近水平：吸附
    pointer(h.canvas, "pointermove", { clientX: TO.x, clientY: FROM.y + 4 });
    expect(livePath(h).getAttribute("d")).toBe("M200 100L800 100");
    expect(livePath(h).getAttribute("stroke-width")).toBe("23.04");
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: TO.x, clientY: FROM.y + 4 });
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({
      tool: "highlighter",
      color: INK_HIGHLIGHTER_COLORS.yellow,
      weight: 23.04,
    });
    expect(strokes[0]?.points.map(({ x, y, p }) => ({ x, y, p }))).toEqual([
      { x: 200, y: 100, p: 0.51 },
      { x: 800, y: 100, p: 0.51 },
    ]);
    expect(StubContext.strokeCalls).toBe(1);
  });
});

describe("标注画布：局部橡皮", () => {
  const PARTIAL_SMALL = {
    type: "eraser",
    mode: "partial",
    size: "small",
  } as const;
  /** 一条存好的横线：底图 (111.11,44.44) → (333.33,44.44)，即 client (150,70) → (250,70) */
  function lineDoc(extra: AnnotationDoc["strokes"] = []): AnnotationDoc {
    return {
      version: 1,
      baseWidth: BASE_W,
      baseHeight: BASE_H,
      strokes: [
        ...extra,
        {
          tool: "pen",
          color: "#1f2328",
          weight: 5.76,
          id: "keep-line",
          points: [
            { x: 111.11, y: 44.44, p: 0.5, t: 0 },
            { x: 333.33, y: 44.44, p: 0.5, t: 16 },
          ],
        },
      ],
      anchors: { "keep-line": "stem/p/0" },
    };
  }
  /** 远处的若干个墨点（不会被擦到），用来把笔画数垫到上限附近 */
  function dots(count: number): AnnotationDoc["strokes"] {
    return Array.from({ length: count }, (_, i) => ({
      tool: "pen" as const,
      color: "#1f2328",
      weight: 5.76,
      id: `dot-${String(i).padStart(5, "0")}`,
      points: [{ x: 10 + i * 7, y: 800, p: 0.5, t: 0 }],
    }));
  }
  function tap(h: ReturnType<typeof mountSurface>, x: number, y: number) {
    pointer(h.canvas, "pointerdown", { clientX: x, clientY: y });
    pointer(h.canvas, "pointerup", { clientX: x, clientY: y });
  }
  const xsOf = (doc: AnnotationDoc) =>
    doc.strokes.map((stroke) => stroke.points.map((point) => point.x));

  it("擦掉中段：两头各成一笔，原笔画进墓碑，段沿用它的锚点", () => {
    const h = mountSurface(lineDoc());
    h.surface.setTool(PARTIAL_SMALL);
    // 落点底图 x=222.22；小号半径 11.52 + 半笔宽 2.88 → 切掉 207.82–236.62
    tap(h, 200, 70);
    const doc = h.surface.getDoc();
    expect(xsOf(doc)).toEqual([
      [111.11, 207.82],
      [236.62, 333.33],
    ]);
    expect(
      doc.deleted?.map(({ id, deletedBy }) => ({ id, deletedBy })),
    ).toEqual([{ id: "keep-line", deletedBy: "eraser" }]);
    const [head, tail] = doc.strokes;
    expect(new Set([head?.id, tail?.id, "keep-line"]).size).toBe(3);
    expect(doc.anchors).toEqual({
      "keep-line": "stem/p/0",
      [head?.id ?? ""]: "stem/p/0",
      [tail?.id ?? ""]: "stem/p/0",
    });
    expect(h.events.at(-1)).toEqual({ reason: "erase", strokes: 2 });
  });

  it("撤销后文档里不带段的锚点（它们既不在正文也不在墓碑），重做后原样回来", () => {
    const h = mountSurface(lineDoc());
    h.surface.setTool(PARTIAL_SMALL);
    tap(h, 200, 70);
    const erased = h.surface.getDoc();

    h.surface.undo();
    const undone = h.surface.getDoc();
    expect(undone.strokes.map((stroke) => stroke.id)).toEqual(["keep-line"]);
    expect(undone.deleted).toBeUndefined();
    expect(undone.anchors).toEqual({ "keep-line": "stem/p/0" });

    h.surface.redo();
    const redone = h.surface.getDoc();
    expect(redone.strokes).toEqual(erased.strokes);
    expect(redone.anchors).toEqual(erased.anchors);
  });

  it("没有锚点的笔画被切开：段也不带锚点", () => {
    const h = mountSurface({ ...lineDoc(), anchors: {} });
    h.surface.setTool(PARTIAL_SMALL);
    tap(h, 200, 70);
    expect(h.surface.getDoc().strokes).toHaveLength(2);
    expect(h.surface.getDoc().anchors).toBeUndefined();
  });

  it("笔画数到上限（200）时：切开会超限的那一笔改为整笔擦掉；还差一笔时照常切开", () => {
    const full = mountSurface(lineDoc(dots(199)));
    full.surface.setTool(PARTIAL_SMALL);
    tap(full, 200, 70);
    expect(full.surface.getDoc().strokes).toHaveLength(199);
    expect(
      full.surface.getDoc().strokes.some((stroke) => stroke.id === "keep-line"),
    ).toBe(false);

    const roomy = mountSurface(lineDoc(dots(198)));
    roomy.surface.setTool(PARTIAL_SMALL);
    tap(roomy, 200, 70);
    expect(roomy.surface.getDoc().strokes).toHaveLength(200);
  });

  it("拖动途中正文不变、只重画改动的那一块；抬起才提交，一次拖动一个历史条目", () => {
    const h = mountSurface(lineDoc(dots(3)));
    h.surface.setTool(PARTIAL_SMALL);
    const clip = vi.spyOn(StubContext.prototype, "clip");
    const clearRect = vi.spyOn(StubContext.prototype, "clearRect");
    StubContext.strokeCalls = 0;
    pointer(h.canvas, "pointerdown", { clientX: 200, clientY: 70 });
    expect(h.surface.getDoc().strokes).toHaveLength(4);
    expect(clip).toHaveBeenCalledTimes(1);
    // 只重放切剩的两段（各 2 个采样点），远处的墨点不重放
    expect(StubContext.strokeCalls).toBe(4);
    const [x, y, width, height] = clearRect.mock
      .calls[0] as unknown as number[];
    expect(x).toBeGreaterThan(0);
    expect((x ?? 0) + (width ?? 0)).toBeLessThan(BASE_W);
    expect(y).toBeGreaterThanOrEqual(0);
    expect((y ?? 0) + (height ?? 0)).toBeLessThan(BASE_H / 2);
    clip.mockRestore();
    clearRect.mockRestore();

    pointer(h.canvas, "pointermove", { clientX: 230, clientY: 70 });
    pointer(h.canvas, "pointerup", { clientX: 230, clientY: 70 });
    expect(h.events.filter((event) => event.reason === "erase")).toHaveLength(
      1,
    );
    expect(h.surface.getDoc().strokes).toHaveLength(5);
    h.surface.undo();
    expect(h.surface.getDoc().strokes).toHaveLength(4);
  });
});

describe("标注画布：橡皮圈", () => {
  function ringOf(h: ReturnType<typeof mountSurface>) {
    const node = h.container.querySelector<SVGElement>(
      INK_ERASER_RING_SELECTOR,
    );
    if (node === null) throw new Error("临时层缺少橡皮圈");
    return {
      shown: node.style.display !== "none",
      at: ["cx", "cy", "r"].map((name) => Number(node.getAttribute(name))),
    };
  }

  it("按下显示在落点（底图像素域）、半径是橡皮半径；拖动跟着走；抬起收起", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "eraser", size: "large" });
    expect(ringOf(h).shown).toBe(false);
    pointer(h.canvas, "pointerdown", { clientX: 200, clientY: 70 });
    // 大号 24 逻辑单位 → 34.56 底图像素
    expect(ringOf(h)).toEqual({ shown: true, at: [222.22, 44.44, 34.56] });
    pointer(h.canvas, "pointermove", { clientX: 250, clientY: 70 });
    expect(ringOf(h).at).toEqual([333.33, 44.44, 34.56]);
    pointer(h.canvas, "pointerup", { clientX: 250, clientY: 70 });
    expect(ringOf(h).shown).toBe(false);
  });

  it("鼠标悬停（没按下）显示橡皮圈；移出画布、换成别的工具都收起；不是橡皮不显示", () => {
    const h = mountSurface();
    const hover = () =>
      pointer(h.canvas, "pointermove", {
        pointerType: "mouse",
        buttons: 0,
        clientX: 200,
        clientY: 70,
      });
    hover();
    expect(ringOf(h).shown).toBe(false);
    h.surface.setTool({ type: "eraser", size: "small" });
    hover();
    expect(ringOf(h)).toEqual({ shown: true, at: [222.22, 44.44, 11.52] });
    h.canvas.dispatchEvent(new PointerEvent("pointerleave"));
    expect(ringOf(h).shown).toBe(false);
    hover();
    h.surface.setTool({ type: "pen" });
    expect(ringOf(h).shown).toBe(false);
  });

  it("橡皮拖动被布局变化打断：按已擦的提交，橡皮圈收起", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 150, y: 70 },
      { x: 250, y: 70 },
    ]);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", { clientX: 200, clientY: 70 });
    expect(ringOf(h).shown).toBe(true);
    h.triggerLayoutChange();
    expect(ringOf(h).shown).toBe(false);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
  });
});

describe("标注画布：荧光笔整笔一条路径", () => {
  /** 书写中那一笔所在的临时层路径 */
  function livePath(h: ReturnType<typeof mountSurface>): Element {
    const path = h.container.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
    if (path === null) throw new Error("临时层未挂载");
    return path;
  }
  /** 绿色粗荧光笔：26 逻辑单位 → 底图像素域 26 × 1440 / 1000 */
  const GREEN_THICK = {
    tool: "highlighter",
    color: INK_HIGHLIGHTER_COLORS.green,
    weight: 37.44,
  } as const;

  it("临时层盖在画布上，坐标域就是底图像素域", () => {
    const h = mountSurface();
    const layer = h.container.querySelector(INK_LIVE_LAYER_SELECTOR);
    expect(layer?.getAttribute("viewBox")).toBe(`0 0 ${BASE_W} ${BASE_H}`);
    expect(layer?.previousElementSibling).toBe(h.canvas);
  });

  it("书写中只更新临时层的一条路径，不往画布上逐段描边", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter", color: "green", size: "thick" });
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 200, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 250, clientY: 100 });
    const path = livePath(h);
    expect(path.getAttribute("d")).toBe(
      onePathSvg([toBase(150, 80), toBase(200, 80), toBase(250, 100)]),
    );
    expect(path.getAttribute("stroke")).toBe(GREEN_THICK.color);
    expect(path.getAttribute("stroke-width")).toBe(String(GREEN_THICK.weight));
    expect(StubContext.strokeCalls).toBe(0);
    expect(h.surface.getDoc().strokes).toHaveLength(0);
  });

  it("抬笔：整笔一次落到画布，临时层清空，文档里是一笔荧光笔", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter", color: "green", size: "thick" });
    writeStroke(h, [
      { x: 150, y: 80 },
      { x: 200, y: 80 },
      { x: 250, y: 100 },
      { x: 150, y: 90 },
    ]);
    expect(StubContext.strokeCalls).toBe(1);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    const strokes = h.surface.getDoc().strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject(GREEN_THICK);
    expect(strokes[0]?.points.map(({ x, y }) => ({ x, y }))).toEqual([
      toBase(150, 80),
      toBase(200, 80),
      toBase(250, 100),
      toBase(150, 90),
    ]);
    expect(h.events.at(-1)).toEqual({ reason: "stroke", strokes: 1 });
  });

  it("撤销、重做后的全量重绘：荧光笔仍是每笔一次描边", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    for (const y of [80, 120]) {
      writeStroke(h, [
        { x: 150, y },
        { x: 200, y },
        { x: 250, y: y + 10 },
      ]);
    }
    StubContext.strokeCalls = 0;
    h.surface.undo();
    expect(StubContext.strokeCalls).toBe(1);
    StubContext.strokeCalls = 0;
    h.surface.redo();
    expect(StubContext.strokeCalls).toBe(2);
  });

  it("笔照旧逐段画在画布上，不经过临时层", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 200, clientY: 80 });
    expect(StubContext.strokeCalls).toBe(2);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("手掌先落、笔后落：手掌那一笔从临时层撤掉，不进文档", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 80,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 1,
      pointerType: "touch",
      clientX: 200,
      clientY: 80,
    });
    pointer(h.canvas, "pointerdown", {
      pointerId: 2,
      pointerType: "pen",
      clientX: 400,
      clientY: 300,
    });
    // 临时层上只剩笔刚落下的这一点
    expect(livePath(h).getAttribute("d")).toBe(onePathSvg([toBase(400, 300)]));
    expect(h.surface.getDoc().strokes).toHaveLength(0);
    pointer(h.canvas, "pointerup", {
      pointerId: 2,
      pointerType: "pen",
      clientX: 400,
      clientY: 300,
    });
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("布局变化：在途荧光笔按已收采样收笔，临时层清空", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 200, clientY: 80 });
    h.triggerLayoutChange();
    expect(h.surface.getDoc().strokes).toHaveLength(1);
    expect(h.surface.getDoc().strokes[0]?.points).toHaveLength(2);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    expect(StubContext.strokeCalls).toBe(1);
  });

  it("落笔后中途换成笔：这一笔仍按落笔时的荧光笔画完", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", { clientX: 150, clientY: 80 });
    h.surface.setTool({ type: "pen" });
    pointer(h.canvas, "pointermove", { clientX: 200, clientY: 80 });
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: 200, clientY: 80 });
    expect(h.surface.getDoc().strokes[0]?.tool).toBe("highlighter");
    expect(StubContext.strokeCalls).toBe(1);
  });
});
