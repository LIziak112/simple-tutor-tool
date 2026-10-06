import type { NoteBackground } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAtramentSurface } from "./atrament-adapter.ts";
import type { InkDoc, InkInputMode } from "./types.ts";

/**
 * atrament 适配器输入生命周期接线测试（T6R.7）。
 *
 * jsdom 没有 canvas 2d 实现——用录制式桩替换 getContext（手法同
 * features/notes/render-note.test.ts），atrament 与适配器的**真实**输入
 * 路径（状态机决策 → 采样收集 → commit/通知）在 jsdom 里完整跑通；
 * 像素绘制只做 no-op（不做像素断言，像素一致性属 E2E/真机口径）。
 * 事件矩阵的纯决策已在 pointer-machine.test.ts 锁定，本文件锁定**接线**：
 * DOM 事件 → 状态机 → store/样式/画布的实际副作用。
 */

// ---------- 录制式 2d 上下文桩（atrament 5.1 依赖面：属性 + 路径 no-op） ----------

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

/** 可手动触发的 ResizeObserver 桩：按创建顺序收集实例 */
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
  getContextSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ---------- 测试夹具 ----------

const CSS_W = 300;
const CSS_H = 200;

interface Harness {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  surface: ReturnType<typeof createAtramentSurface>;
  /** onChange 收到的事件（reason + 当时笔画数） */
  events: Array<{ reason: string; strokes: number }>;
  /** 触发一次布局变化（模拟 resize/旋转：先改容器宽再手动触发观察器回调） */
  resizeTo(width: number, height?: number): void;
}

function mountSurface(
  opts: {
    inputMode?: InkInputMode;
    background?: NoteBackground;
    initial?: InkDoc;
  } = {},
): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let w = CSS_W;
  let h = CSS_H;
  Object.defineProperty(container, "clientWidth", {
    configurable: true,
    get: () => w,
  });
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    get: () => h,
  });
  const surface = createAtramentSurface({
    ...(opts.inputMode ? { inputMode: opts.inputMode } : {}),
    ...(opts.background ? { background: opts.background } : {}),
  });
  if (opts.initial) surface.mount(container, opts.initial);
  else surface.mount(container);
  const canvas = container.querySelector("canvas[data-slot=ink-canvas]");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("画布未挂载");
  const events: Harness["events"] = [];
  surface.onChange((doc, reason) => {
    events.push({
      reason,
      strokes: (doc as InkDoc<"atrament">).data.strokes.length,
    });
  });
  return {
    container,
    canvas,
    surface,
    events,
    resizeTo(width: number, height = h) {
      w = width;
      h = height;
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
      clientX: opts.clientX ?? 20,
      clientY: opts.clientY ?? 20,
    }),
  );
}

/** 派发 lostpointercapture（jsdom 无原生派发时机，手动补） */
function lostCapture(canvas: HTMLCanvasElement, pointerId: number): void {
  canvas.dispatchEvent(
    new PointerEvent("lostpointercapture", {
      bubbles: true,
      pointerId,
      pointerType: "pen",
    }),
  );
}

/**
 * pointerdown 参数构造（复审⑬：内联字面量统一收口；坐标默认 (20,20)、
 * pointerId 默认 1，与 pointer() 的缺省一致）
 */
function pd(
  pointerType: string,
  pointerId = 1,
  clientX = 20,
  clientY = 20,
): {
  pointerType: string;
  pointerId: number;
  clientX: number;
  clientY: number;
} {
  return { pointerType, pointerId, clientX, clientY };
}

/** 派发 touchstart/touchmove（jsdom 无 TouchEvent 构造器，用可赋值 Event 模拟触点表） */
function touch(
  canvas: HTMLCanvasElement,
  type: "touchstart" | "touchmove",
  touchTypes: string[],
): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "changedTouches", {
    value: touchTypes.map((touchType) => ({ touchType })),
  });
  canvas.dispatchEvent(ev);
}

/** 写一笔（down → moves → up），返回收到的 change 原因序列 */
function writeStroke(
  h: Harness,
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

function strokesOf(h: Harness) {
  return (h.surface.getDoc() as InkDoc<"atrament">).data.strokes;
}

/** 坐标断言用：CSS 像素 → 逻辑（与引擎 toLogical 同式，保留 2 位小数） */
function toLogical(css: number): number {
  return Math.round((css / CSS_W) * 1000 * 100) / 100;
}

function oneStrokeDoc(): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 100, y: 100, p: 0.5, t: 0 },
            { x: 200, y: 100, p: 0.5, t: 10 },
          ],
        },
      ],
    },
    updatedAt: 1,
  } as InkDoc;
}

// ---------- 测试 ----------

describe("atrament-adapter：auto 模式（旧行为兼容）", () => {
  it("未见笔时手指可写（旧自动探测）；笔到后手掌笔段被丢弃，此后手指不落墨", () => {
    const h = mountSurface();
    // 手指先写两笔采样
    writeStroke(
      h,
      [
        { x: 20, y: 20 },
        { x: 60, y: 20 },
      ],
      {
        pointerType: "touch",
        pointerId: 1,
      },
    );
    expect(strokesOf(h)).toHaveLength(1);

    // 手掌（touch id=5）先落、笔随后落下：手掌笔段被丢弃（不入库），笔接管
    pointer(h.canvas, "pointerdown", pd("touch", 5, 40, 40));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 5,
      clientX: 60,
      clientY: 40,
    });
    pointer(h.canvas, "pointerdown", pd("pen", 9, 80, 80));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      pointerId: 9,
      clientX: 100,
      clientY: 80,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      pointerId: 9,
      clientX: 100,
      clientY: 80,
    });
    expect(strokesOf(h)).toHaveLength(2); // 手指一笔 + 笔一笔；手掌笔段未入库
    // 手掌 up 到来（迟到）：不产生新笔画
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      pointerId: 5,
      clientX: 60,
      clientY: 40,
    });
    expect(strokesOf(h)).toHaveLength(2);

    // pen-only 生效：此后手指不再落墨
    writeStroke(
      h,
      [
        { x: 20, y: 100 },
        { x: 80, y: 100 },
      ],
      {
        pointerType: "touch",
        pointerId: 11,
      },
    );
    expect(strokesOf(h)).toHaveLength(2);
  });

  it("touch-action：未见笔 none（手指书写）→ 见过笔 pan-y（旧语义）", () => {
    const h = mountSurface();
    expect(h.canvas.style.touchAction).toBe("none");
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 20,
      clientY: 20,
    });
    expect(h.canvas.style.touchAction).toBe("pan-y");
  });
});

describe("atrament-adapter：pen 输入模式（新草稿缺省：笔写/手指滚动）", () => {
  it("首次手指不落墨（无 change、无笔画）、touch-action 恒 pan-y；笔与鼠标可写", () => {
    const h = mountSurface({ inputMode: "pen" });
    expect(h.canvas.style.touchAction).toBe("pan-y");
    expect(h.container.style.touchAction).toBe("pan-y");

    writeStroke(
      h,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
      ],
      {
        pointerType: "touch",
        pointerId: 1,
      },
    );
    expect(strokesOf(h)).toHaveLength(0);
    expect(h.events).toHaveLength(0);

    writeStroke(
      h,
      [
        { x: 20, y: 60 },
        { x: 80, y: 60 },
      ],
      { pointerType: "pen" },
    );
    writeStroke(
      h,
      [
        { x: 20, y: 120 },
        { x: 80, y: 120 },
      ],
      { pointerType: "mouse" },
    );
    expect(strokesOf(h)).toHaveLength(2);
    // 手指书写仍不改变 touch-action（模式语义固定，探测无关）
    expect(h.canvas.style.touchAction).toBe("pan-y");
  });

  it("finger 模式：手指直接书写（touch-action none），在途手指笔段不被笔接管", () => {
    const h = mountSurface({ inputMode: "finger" });
    expect(h.canvas.style.touchAction).toBe("none");

    pointer(h.canvas, "pointerdown", pd("touch", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 60,
      clientY: 20,
    });
    // 手指书写中笔轻点：不接管、不丢弃
    pointer(h.canvas, "pointerdown", pd("pen", 2, 90, 90));
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 20,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 20,
    });

    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(3); // 手指笔段完整：20,60,100 三点
  });
});

describe("atrament-adapter：多指与多画布", () => {
  it("auto 模式多指：第二手指不接管活动手指（不再覆盖在途笔段）", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("touch", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });
    // 第二手指落下并移动：全部忽略
    pointer(h.canvas, "pointerdown", pd("touch", 2, 80, 80));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });
    // 第一手指继续并收笔
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 20,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 100,
      clientY: 20,
    });
    // 第二手指迟到 up：无效
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });

    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(3); // 只有手指 1 的三点
  });

  it("两个画布并存：状态机/笔迹互不串（A 写不影响 B）", () => {
    const a = mountSurface();
    const b = mountSurface();
    writeStroke(a, [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ]);
    expect(strokesOf(a)).toHaveLength(1);
    expect(strokesOf(b)).toHaveLength(0);
    // A 已见过笔（auto→penOnly）不影响 B 的手指书写
    writeStroke(
      b,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
      ],
      { pointerType: "touch" },
    );
    expect(strokesOf(b)).toHaveLength(1);
    expect(strokesOf(a)).toHaveLength(1);
    expect(a.canvas).not.toBe(b.canvas);
  });
});

describe("atrament-adapter：取消/失焦/丢捕获（只保留已收真实采样）", () => {
  it("pointercancel：按已收点收笔、不补造终点；后续事件不粘笔；新手势正常", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    // 取消事件自带远端坐标（999,999）——不得进入笔画
    pointer(h.canvas, "pointercancel", {
      pointerType: "pen",
      clientX: 999,
      clientY: 999,
    });
    expect(strokesOf(h)).toHaveLength(1);
    const s = strokesOf(h)[0];
    expect(s?.points).toHaveLength(2);
    expect(s?.points.at(-1)?.x).toBe(toLogical(60));
    // 同一物理手势的后续 move/up：全部忽略（不粘笔）
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 150,
      clientY: 20,
      buttons: 1,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 150,
      clientY: 20,
    });
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    // 新手势正常书写
    writeStroke(h, [
      { x: 20, y: 100 },
      { x: 60, y: 100 },
    ]);
    expect(strokesOf(h)).toHaveLength(2);
  });

  it("lostpointercapture：活动笔段收笔；随后的 pointerup 不双收", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    lostCapture(h.canvas, 1);
    expect(strokesOf(h)).toHaveLength(1);
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    expect(strokesOf(h)).toHaveLength(1);
    expect(h.events.filter((e) => e.reason === "stroke")).toHaveLength(1);
  });

  it("窗口失焦：在途笔段按已收采样收笔（不依赖未必送达的 pointerup）", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    window.dispatchEvent(new Event("blur"));
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    expect(h.events.at(-1)?.reason).toBe("stroke");
  });
});

describe("atrament-adapter：布局变化（旋转/resize）不混用两个坐标变换", () => {
  it("一笔在途时 resize：先按已收点收笔（旧宽度基准），resize 后同手势的 move 不追加", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 50, 50));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 100,
      clientY: 50,
    });
    // 模拟旋转：容器宽 300 → 500，触发 ResizeObserver
    h.resizeTo(500);
    // 同一物理手势在 resize 后的移动：丢弃（新坐标变换不混入旧笔画）
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 150,
      clientY: 50,
      buttons: 1,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 150,
      clientY: 50,
    });

    expect(strokesOf(h)).toHaveLength(1);
    const points = strokesOf(h)[0]?.points;
    expect(points).toHaveLength(2);
    // 坐标仍是旧宽度（300）基准的逻辑值
    expect(points?.[0]?.x).toBe(toLogical(50));
    expect(points?.[1]?.x).toBe(toLogical(100));
    // 画布尺寸已重设为新宽度（jsdom dpr=1）
    expect(h.canvas.width).toBe(500);
    expect(h.events.at(-1)?.reason).toBe("stroke");
  });

  it("空闲时 resize：不产生任何 change（只是重设画布与重绘）", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ]);
    h.events.length = 0;
    h.resizeTo(500);
    expect(h.events).toHaveLength(0);
    expect(strokesOf(h)).toHaveLength(1);
  });
});

describe("atrament-adapter：触摸侧 stylus 识别（遍历触点，不默认 touches[0]）", () => {
  it("手掌先落（direct）不 preventDefault；笔第二个落下（changedTouches 含 stylus）preventDefault 并进入 pen-only", () => {
    const h = mountSurface();
    touch(h.canvas, "touchstart", ["direct"]);
    // 直接触摸不拦截（页面照常滚动）
    // （jsdom Event 的 defaultPrevented 依赖 cancelable + preventDefault 调用）
    // 手掌先落场景：changedTouches 只有 direct → 不拦截
    // 笔随后落下：该 touchstart 的 changedTouches 含 stylus → 拦截 + pen-only
    touch(h.canvas, "touchstart", ["stylus"]);
    expect(h.canvas.style.touchAction).toBe("pan-y"); // pen-only 已生效
    // 此后手指不再落墨
    writeStroke(
      h,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
      ],
      {
        pointerType: "touch",
        pointerId: 3,
      },
    );
    expect(strokesOf(h)).toHaveLength(0);
  });

  it("touchmove 仅在 changedTouches 含 stylus 时 preventDefault", () => {
    const h = mountSurface();
    const evDirect = new Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(evDirect, "changedTouches", {
      value: [{ touchType: "direct" }],
    });
    h.canvas.dispatchEvent(evDirect);
    expect(evDirect.defaultPrevented).toBe(false);

    const evStylus = new Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(evStylus, "changedTouches", {
      value: [{ touchType: "direct" }, { touchType: "stylus" }],
    });
    h.canvas.dispatchEvent(evStylus);
    expect(evStylus.defaultPrevented).toBe(true);
  });
});

describe("atrament-adapter：setInputMode 与 touch-action 随模式切换", () => {
  it("运行时切换：auto→finger（touch-action none、手指可写）→pen（手指不落墨）", () => {
    const h = mountSurface();
    expect(h.canvas.style.touchAction).toBe("none");
    h.surface.setInputMode?.("finger");
    expect(h.canvas.style.touchAction).toBe("none");
    writeStroke(
      h,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
      ],
      {
        pointerType: "touch",
        pointerId: 1,
      },
    );
    expect(strokesOf(h)).toHaveLength(1);
    h.surface.setInputMode?.("pen");
    expect(h.canvas.style.touchAction).toBe("pan-y");
    writeStroke(
      h,
      [
        { x: 20, y: 60 },
        { x: 80, y: 60 },
      ],
      {
        pointerType: "touch",
        pointerId: 2,
      },
    );
    expect(strokesOf(h)).toHaveLength(1); // 手指不再落墨
  });
});

describe("atrament-adapter：回归（撤销/重做/橡皮/鼠标/load）", () => {
  it("鼠标书写 → 撤销 → 重做 → 橡皮整笔擦除（reason 分型不变）", () => {
    const h = mountSurface();
    writeStroke(
      h,
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
      ],
      { pointerType: "mouse" },
    );
    expect(h.surface.canUndo()).toBe(true);
    expect(h.events.at(-1)?.reason).toBe("stroke");

    h.surface.undo();
    expect(strokesOf(h)).toHaveLength(0);
    expect(h.events.at(-1)?.reason).toBe("undo");

    h.surface.redo();
    expect(strokesOf(h)).toHaveLength(1);
    expect(h.events.at(-1)?.reason).toBe("redo");

    // 橡皮：点在笔画真实采样点上（(20,20) → 逻辑 66.67,66.67）整笔擦除
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", pd("mouse", 1, 20, 20));
    pointer(h.canvas, "pointerup", {
      pointerType: "mouse",
      clientX: 20,
      clientY: 20,
    });
    expect(strokesOf(h)).toHaveLength(0);
    expect(h.events.at(-1)?.reason).toBe("erase");
  });

  it("load 全程 reason=load（不触发编辑计数口径）；书写后仍为 stroke", () => {
    // 初始恢复发生在 mount 内部（早于 onChange 注册，与旧语义一致——不通知）
    const h = mountSurface({ initial: oneStrokeDoc() });
    expect(h.events).toEqual([]);
    expect(strokesOf(h)).toHaveLength(1);
    // 显式 load：reason 恒为 load（消费方把 load 排除在 dirty/编辑计数之外）
    h.surface.load(oneStrokeDoc());
    expect(h.events).toEqual([{ reason: "load", strokes: 1 }]);
    writeStroke(h, [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ]);
    expect(h.events.at(-1)).toEqual({ reason: "stroke", strokes: 2 });
  });
});

describe("atrament-adapter：屏幕端纸张背景（可选配置，缺省零变化）", () => {
  it("缺省不设置任何背景样式（旧作答组件零变化）", () => {
    const h = mountSurface();
    expect(h.canvas.style.backgroundImage).toBe("");
    expect(h.canvas.style.backgroundColor).toBe("");
  });

  it("grid 背景：canvas 背景与 PNG 同源常量，间距随宽度换算并在 resize 后更新", () => {
    const h = mountSurface({ background: "grid" });
    // 300 宽 → 间距 12px、线带 [11px,12px)（jsdom 归一化：颜色转 rgb、
    // 默认方向 to bottom 被省略——完整字符串口径由 paper-style.test 锁定）
    expect(h.canvas.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(h.canvas.style.backgroundImage).toContain("transparent 11px");
    expect(h.canvas.style.backgroundImage).toContain("to right");
    expect(
      h.canvas.style.backgroundImage.split("repeating-linear-gradient"),
    ).toHaveLength(3); // 竖线 + 横线两条渐变
  });
});
