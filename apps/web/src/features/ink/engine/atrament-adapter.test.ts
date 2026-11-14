import type { InkRendering, NoteBackground } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAtramentSurface } from "./atrament-adapter.ts";
import { createProgrammaticAtrament } from "./atrament-replay.ts";
import { onePathSvg } from "./highlighter-paint.ts";
import {
  INK_ERASER_RING_SELECTOR,
  INK_LIVE_LAYER_SELECTOR,
} from "./live-layer.ts";
import {
  INK_HIGHLIGHTER_COLORS,
  INK_HIGHLIGHTER_SIZES,
  type InkDoc,
  type InkInputMode,
} from "./types.ts";

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
  /** 累计描边次数（荧光笔「整笔一次描边」的观察点；beforeEach 清零） */
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

it("统一绘制入口默认使用 0.35，实时书写与导出回放共用低平滑", () => {
  const renderer = createProgrammaticAtrament(document.createElement("canvas"));
  expect(renderer.smoothing).toBe(0.35);
});

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
  // 夹具统一清理（复审⑧）：销毁 surface（解绑 window/document 监听）并移除
  // 容器（不留悬挂 DOM），单个测试无需自理
  for (const h of activeHarnesses.splice(0)) {
    h.surface.destroy();
    h.container.remove();
  }
  getContextSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ---------- 测试夹具 ----------

const CSS_W = 300;
const CSS_H = 200;

/** 本文件挂载的全部夹具（afterEach 统一 destroy + 移除容器，复审⑧） */
const activeHarnesses: Array<{
  surface: ReturnType<typeof createAtramentSurface>;
  container: HTMLDivElement;
}> = [];

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
    rendering?: InkRendering;
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
    ...(opts.rendering ? { rendering: opts.rendering } : {}),
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
  const harness: Harness = {
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
  // 统一登记，afterEach 集中销毁+移除（复审⑧：测试自弃不留悬挂监听）
  activeHarnesses.push(harness);
  return harness;
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

it("实验平滑调参保留撤销历史与输入面", () => {
  const h = mountSurface();
  pointer(h.canvas, "pointerdown");
  pointer(h.canvas, "pointermove", { clientX: 40 });
  pointer(h.canvas, "pointerup");
  h.surface.setSmoothing(0.15);
  expect(h.surface.canUndo()).toBe(true);
  h.surface.undo();
  // LR-2：撤销新增会产墓碑（deletedBy "undo"）——过程信号随文档进出
  expect(h.surface.getDoc().data).toEqual({
    width: 1000,
    strokes: [],
    deleted: [
      expect.objectContaining({
        deletedBy: "undo",
        points: expect.any(Array),
      }),
    ],
  });
  expect(h.surface.canRedo()).toBe(true);
  h.surface.setSmoothing(0.4);
  h.surface.redo();
  expect(h.surface.getDoc().data).toMatchObject({
    strokes: [{ points: expect.any(Array) }],
  });
});

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

/**
 * 派发 touchstart/touchmove（jsdom 无 TouchEvent 构造器，用可赋值 Event
 * 模拟触点表）。allTouches 缺省＝changedTouches（单指场景）；笔在屏手掌
 * 后落场景传并集（复审②）。
 */
function touch(
  canvas: HTMLCanvasElement,
  type: "touchstart" | "touchmove",
  touchTypes: string[],
  allTouches: string[] = touchTypes,
): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "changedTouches", {
    value: touchTypes.map((touchType) => ({ touchType })),
  });
  Object.defineProperty(ev, "touches", {
    value: allTouches.map((touchType) => ({ touchType })),
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

  it("finger 模式：手指直接书写（touch-action none）；书写中笔落下＝自愈收笔接管（复审①）", () => {
    const h = mountSurface({ inputMode: "finger" });
    expect(h.canvas.style.touchAction).toBe("none");

    pointer(h.canvas, "pointerdown", pd("touch", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 60,
      clientY: 20,
    });
    // 手指书写中笔轻点：手指笔段按已收点收笔（不丢弃），笔接管
    pointer(h.canvas, "pointerdown", pd("pen", 2, 90, 90));
    expect(strokesOf(h)).toHaveLength(1); // 手指笔段已收笔（2 点）
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });
    // 手指的迟到事件（move/up）：已非活动指针，全部忽略
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

    expect(strokesOf(h)).toHaveLength(2); // 手指一笔 + 笔轻点一笔
    expect(strokesOf(h)[0]?.points).toHaveLength(2); // 手指笔段保持 2 点（迟到点不混入）
  });
});

describe("atrament-adapter：多指与多画布", () => {
  it("auto 模式多指：第二手指落下＝自愈收笔接管（在途笔保留已收点，复审①）", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("touch", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 50,
      clientY: 20,
    });
    // 第二手指落下：第一手指笔段按已收点收笔，第二手指接管
    pointer(h.canvas, "pointerdown", pd("touch", 2, 80, 80));
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });
    // 第一手指的迟到事件：已非活动指针，全部忽略（不粘笔、不混入）
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
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });

    expect(strokesOf(h)).toHaveLength(2); // 手指 1 一笔（2 点）+ 手指 2 一笔
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
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
  it("切编辑域显式收笔，保留已收采样和原撤销历史", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", {
      pointerId: 1,
      pointerType: "pen",
      clientX: 100,
      clientY: 50,
    });
    pointer(h.canvas, "pointermove", {
      pointerId: 1,
      pointerType: "pen",
      clientX: 140,
      clientY: 80,
    });
    h.surface.finish?.();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.strokes).toBe(1);
    h.surface.undo();
    expect(h.events.at(-1)?.strokes).toBe(0);
  });
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

  it("收尾丢失自愈（复审①）：up 不发后鼠标再 down——在途笔按已收点提交且书写恢复", () => {
    const h = mountSurface();
    // capture 丢失形态：pen down + 1 move 后 up/cancel 全部未达
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    // 鼠标再 down：自愈收笔（superseded）+ 新笔开始，书写恢复
    pointer(h.canvas, "pointerdown", pd("mouse", 2, 20, 100));
    expect(strokesOf(h)).toHaveLength(1); // 在途笔已按已收点提交（2 点）
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    pointer(h.canvas, "pointermove", {
      pointerType: "mouse",
      pointerId: 2,
      clientX: 80,
      clientY: 100,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "mouse",
      pointerId: 2,
      clientX: 80,
      clientY: 100,
    });
    expect(strokesOf(h)).toHaveLength(2);
    expect(strokesOf(h)[1]?.points).toHaveLength(2); // 新笔正常书写
  });

  it("落笔工具快照（复审③）：在途中途切橡皮后 blur 收笔——仍按落笔工具提交整笔", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    // 笔未抬起时工具条切到橡皮（旧分派读当前工具会误走橡皮分支丢笔迹）
    h.surface.setTool({ type: "eraser" });
    window.dispatchEvent(new Event("blur"));
    expect(strokesOf(h)).toHaveLength(1); // 笔迹未被丢弃
    expect(strokesOf(h)[0]?.tool).toBe("pen"); // 按落笔工具提交
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    expect(h.events.at(-1)?.reason).toBe("stroke");
  });

  it("页面隐藏（visibilitychange）兜底（复审④）：与 blur 同口径收笔且幂等", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    // 遮蔽原型 getter 模拟「页面进入隐藏」，finally 里移除遮蔽还原
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    expect(h.events.filter((e) => e.reason === "stroke")).toHaveLength(1); // 不双提交
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
    // 手掌先落场景：changedTouches 只有 direct → 不拦截
    const palmFirst = new Event("touchstart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(palmFirst, "changedTouches", {
      value: [{ touchType: "direct" }],
    });
    Object.defineProperty(palmFirst, "touches", {
      value: [{ touchType: "direct" }],
    });
    h.canvas.dispatchEvent(palmFirst);
    expect(palmFirst.defaultPrevented).toBe(false);

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

  it("笔先落手掌后落（复审②）：changedTouches 只含 direct 但 touches 含 stylus → 拦截", () => {
    const h = mountSurface();
    // 笔先落书写（pointer 事件路径进入 pen-only，touch-action 已 pan-y）
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    // 手掌后落：新触点是 direct，但屏上仍有笔（touches 含 stylus）——
    // 并集口径须拦截（否则手掌触摸可引发原生滚动破坏笔迹）
    touch(h.canvas, "touchstart", ["direct"], ["stylus", "direct"]);
    // 上面的 touch 助手不回传事件对象，直接再验一次同形态 touchmove
    const ev = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "changedTouches", {
      value: [{ touchType: "direct" }],
    });
    Object.defineProperty(ev, "touches", {
      value: [{ touchType: "stylus" }, { touchType: "direct" }],
    });
    h.canvas.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // 纯 direct（无笔在屏）不拦截
    const evPure = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(evPure, "changedTouches", {
      value: [{ touchType: "direct" }],
    });
    Object.defineProperty(evPure, "touches", {
      value: [{ touchType: "direct" }],
    });
    h.canvas.dispatchEvent(evPure);
    expect(evPure.defaultPrevented).toBe(false);
  });

  it("touchmove 仅在触点含 stylus 时 preventDefault", () => {
    const h = mountSurface();
    const evDirect = new Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(evDirect, "changedTouches", {
      value: [{ touchType: "direct" }],
    });
    Object.defineProperty(evDirect, "touches", {
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
    Object.defineProperty(evStylus, "touches", {
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
  it("橡皮未抬起时撤销先收笔，迟到抬笔不再次删除", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 220, y: 40 },
      { x: 260, y: 40 },
    ]);
    writeStroke(h, [
      { x: 20, y: 40 },
      { x: 60, y: 40 },
    ]);
    const original = strokesOf(h);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", pd("pen", 1, 240, 40));
    h.surface.undo();
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 240,
      clientY: 40,
    });
    expect(strokesOf(h)).toEqual(original);
    h.surface.redo();
    expect(strokesOf(h)).toEqual([original[1]]);
  });
  it.each(["pointerup", "pointercancel"] as const)(
    "擦右侧后 %s 重绘保留后写的左侧笔迹，撤销重做一致",
    (end) => {
      const h = mountSurface();
      writeStroke(h, [
        { x: 220, y: 40 },
        { x: 260, y: 40 },
      ]);
      writeStroke(h, [
        { x: 20, y: 40 },
        { x: 60, y: 40 },
      ]);
      const original = strokesOf(h);
      h.surface.setTool({ type: "eraser" });
      pointer(h.canvas, "pointerdown", pd("pen", 1, 240, 40));
      const paint = vi.spyOn(StubContext.prototype, "quadraticCurveTo");
      pointer(h.canvas, end, { pointerType: "pen", clientX: 240, clientY: 40 });
      expect(strokesOf(h)).toEqual([original[1]]);
      expect(paint).toHaveBeenCalled();
      paint.mockClear();
      h.surface.undo();
      expect(strokesOf(h)).toEqual(original);
      expect(paint).toHaveBeenCalled();
      paint.mockClear();
      h.surface.redo();
      expect(strokesOf(h)).toEqual([original[1]]);
      expect(paint).toHaveBeenCalled();
      paint.mockRestore();
    },
  );

  it("快速橡皮拖动经过笔画仍擦除，远处笔画保留", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 120, y: 20 },
      { x: 120, y: 80 },
    ]);
    writeStroke(h, [
      { x: 250, y: 20 },
      { x: 250, y: 80 },
    ]);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", pd("pen", 1, 80, 40));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 160,
      clientY: 40,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 160,
      clientY: 40,
    });
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points[0]?.x).toBeGreaterThan(800);
  });

  it("橡皮大小决定命中范围：同一位置小号擦不到、中号擦得到；再远一点只有大号擦得到", () => {
    const h = mountSurface();
    // 横线 y=40；画布宽 300 → 1 CSS px = 3.33 逻辑单位，笔宽 4（半宽 2）
    const line = [
      { x: 100, y: 40 },
      { x: 200, y: 40 },
    ];
    const tapAt = (y: number) => {
      pointer(h.canvas, "pointerdown", pd("pen", 1, 150, y));
      pointer(h.canvas, "pointerup", {
        pointerType: "pen",
        clientX: 150,
        clientY: y,
      });
    };
    writeStroke(h, line);
    // 离线 4px = 13.3 逻辑单位：小号 8+2 够不着，中号 14+2 够得着
    h.surface.setTool({ type: "eraser", size: "small" });
    tapAt(44);
    expect(strokesOf(h)).toHaveLength(1);
    h.surface.setTool({ type: "eraser", size: "medium" });
    tapAt(44);
    expect(strokesOf(h)).toHaveLength(0);

    h.surface.setTool({ type: "pen" });
    writeStroke(h, line);
    // 离线 6px = 20 逻辑单位：不带大小（缺省中号）够不着，大号 24+2 够得着
    h.surface.setTool({ type: "eraser" });
    tapAt(46);
    expect(strokesOf(h)).toHaveLength(1);
    h.surface.setTool({ type: "eraser", size: "large" });
    tapAt(46);
    expect(strokesOf(h)).toHaveLength(0);
  });

  it("橡皮大小按落笔时为准：拖动途中改大小不影响这一次拖动", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 100, y: 40 },
      { x: 200, y: 40 },
    ]);
    h.surface.setTool({ type: "eraser", size: "small" });
    pointer(h.canvas, "pointerdown", pd("pen", 1, 150, 80));
    h.surface.setTool({ type: "eraser", size: "large" });
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 150,
      clientY: 46,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 150,
      clientY: 46,
    });
    expect(strokesOf(h)).toHaveLength(1);
  });
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

  it("load 在途笔先按已收采样收笔再换正文（在途笔提交不丢、不粘笔——复审②）", () => {
    const h = mountSurface({ initial: oneStrokeDoc() });
    pointer(h.canvas, "pointerdown", pd("pen", 1, 20, 20));
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 60,
      clientY: 20,
    });
    h.events.length = 0;
    h.surface.load(oneStrokeDoc());
    // 顺序：先提交在途笔（旧正文 1+1），再换正文（1 笔新稿）
    expect(h.events.map((e) => e.reason)).toEqual(["stroke", "load"]);
    expect(h.events[0]?.strokes).toBe(2);
    expect(h.events[1]?.strokes).toBe(1);
    // 收笔后同一手势后续事件忽略（不粘笔）
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      clientX: 80,
      clientY: 20,
    });
    pointer(h.canvas, "pointerup", {
      pointerType: "pen",
      clientX: 80,
      clientY: 20,
    });
    expect(h.events.filter((e) => e.reason === "stroke")).toHaveLength(1);
  });

  it("load 时橡皮的 pendingErase 先按旧下标提交再换正文（不删错新稿——复审②）", () => {
    const h = mountSurface({ initial: oneStrokeDoc() });
    // 橡皮拖过既有笔画采样点（逻辑 100→200 @y100 = CSS (30,30)→(60,30)）
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", pd("mouse", 1, 30, 30));
    pointer(h.canvas, "pointermove", {
      pointerType: "mouse",
      clientX: 60,
      clientY: 30,
    });
    h.events.length = 0;
    h.surface.load(oneStrokeDoc());
    // 先按旧下标提交 erase（旧正文 1→0），再换正文（1 笔新稿）——
    // 若 replace 先行，陈旧下标会误删新稿笔画
    expect(h.events.map((e) => e.reason)).toEqual(["erase", "load"]);
    expect(h.events[1]?.strokes).toBe(1);
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
  it("切换全屏前主动收笔释放捕获，只提交一次真实采样", () => {
    const h = mountSurface();
    const release = vi.fn();
    h.canvas.hasPointerCapture = () => true;
    h.canvas.releasePointerCapture = release;
    pointer(h.canvas, "pointerdown");
    pointer(h.canvas, "pointermove", { clientX: 80 });
    h.surface.finish?.();
    expect(release).toHaveBeenCalledWith(1);
    expect(strokesOf(h)).toHaveLength(1);
    pointer(h.canvas, "pointerup");
    expect(strokesOf(h)).toHaveLength(1);
  });
  it("保活纸面禁用输入时解绑事件，重新启用仍能撤销原笔", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
    ]);
    expect(h.surface.setInputEnabled).toBeTypeOf("function");
    h.surface.setInputEnabled?.(false);
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 90, y: 30 },
    ]);
    expect(strokesOf(h)).toHaveLength(1);
    expect(h.canvas.dataset.inputEnabled).toBe("false");
    h.surface.setInputEnabled?.(true);
    h.surface.undo();
    expect(strokesOf(h)).toHaveLength(0);
    h.surface.redo();
    expect(strokesOf(h)).toHaveLength(1);
  });
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

describe("atrament-adapter：荧光笔整笔一条路径", () => {
  /** 书写中那一笔所在的临时层路径 */
  function livePath(h: Harness): Element {
    const path = h.container.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
    if (path === null) throw new Error("临时层未挂载");
    return path;
  }
  const logical = (x: number, y: number) => ({
    x: toLogical(x),
    y: toLogical(y),
  });
  const PINK_THIN = {
    tool: "highlighter",
    color: INK_HIGHLIGHTER_COLORS.pink,
    weight: INK_HIGHLIGHTER_SIZES.thin,
  } as const;

  it("临时层盖在画布上、悬停圈之下；坐标域是逻辑宽 1000，随尺寸变化更新", () => {
    const h = mountSurface();
    const layer = h.container.querySelector(INK_LIVE_LAYER_SELECTOR);
    expect(layer?.previousElementSibling).toBe(h.canvas);
    expect(layer?.nextElementSibling?.getAttribute("data-slot")).toBe(
      "ink-hover",
    );
    // 300×200 的容器：逻辑高 200 / 300 × 1000
    expect(layer?.getAttribute("viewBox")).toBe("0 0 1000 666.67");
    h.resizeTo(600, 300);
    expect(layer?.getAttribute("viewBox")).toBe("0 0 1000 500");
  });

  it("书写中只更新临时层的一条路径，不往画布上逐段描边", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter", color: "pink", size: "thin" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 30, clientY: 33 });
    const path = livePath(h);
    expect(path.getAttribute("d")).toBe(
      onePathSvg([logical(30, 30), logical(90, 30), logical(30, 33)]),
    );
    expect(path.getAttribute("stroke")).toBe(PINK_THIN.color);
    expect(path.getAttribute("stroke-width")).toBe(String(PINK_THIN.weight));
    expect(StubContext.strokeCalls).toBe(0);
    expect(strokesOf(h)).toHaveLength(0);
  });

  it("抬笔：整笔一次落到画布，临时层清空，文档里是一笔荧光笔", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter", color: "pink", size: "thin" });
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 90, y: 30 },
      { x: 30, y: 33 },
      { x: 90, y: 36 },
    ]);
    expect(StubContext.strokeCalls).toBe(1);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    const strokes = strokesOf(h);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject(PINK_THIN);
    expect(strokes[0]?.points.map(({ x, y }) => ({ x, y }))).toEqual([
      logical(30, 30),
      logical(90, 30),
      logical(30, 33),
      logical(90, 36),
    ]);
    expect(h.events.at(-1)).toEqual({ reason: "stroke", strokes: 1 });
  });

  it("撤销、重做后的全量重绘：荧光笔仍是每笔一次描边", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    for (const y of [30, 60]) {
      writeStroke(h, [
        { x: 30, y },
        { x: 90, y },
        { x: 150, y: y + 6 },
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
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 30 });
    expect(StubContext.strokeCalls).toBe(2);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("手掌先落、笔后落：手掌那一笔从临时层撤掉，不进文档", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", pd("touch", 1, 30, 30));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 90,
      clientY: 30,
    });
    pointer(h.canvas, "pointerdown", pd("pen", 2, 150, 120));
    // 临时层上只剩笔刚落下的这一点
    expect(livePath(h).getAttribute("d")).toBe(onePathSvg([logical(150, 120)]));
    expect(strokesOf(h)).toHaveLength(0);
    pointer(h.canvas, "pointerup", pd("pen", 2, 150, 120));
    expect(strokesOf(h)).toHaveLength(1);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("尺寸变化：在途荧光笔按已收采样收笔，临时层清空", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 30 });
    h.resizeTo(600);
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points).toHaveLength(2);
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("落笔后中途换成笔：这一笔仍按落笔时的荧光笔画完", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    h.surface.setTool({ type: "pen" });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 30 });
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: 90, clientY: 30 });
    expect(strokesOf(h)[0]?.tool).toBe("highlighter");
    expect(StubContext.strokeCalls).toBe(1);
  });
});

describe("atrament-adapter：局部橡皮", () => {
  const PARTIAL_SMALL = {
    type: "eraser",
    mode: "partial",
    size: "small",
  } as const;
  const xsOf = (h: Harness) =>
    strokesOf(h).map((stroke) => stroke.points.map((point) => point.x));
  /** 橡皮点一下 */
  function tap(h: Harness, x: number, y: number, pointerType = "pen") {
    pointer(h.canvas, "pointerdown", pd(pointerType, 1, x, y));
    pointer(h.canvas, "pointerup", { pointerType, clientX: x, clientY: y });
  }
  /** 一条 y=40 的横线：CSS 100→200，即逻辑 333.33→666.67，笔宽 4 */
  function writeLine(h: Harness, y = 40) {
    writeStroke(h, [
      { x: 100, y },
      { x: 200, y },
    ]);
  }

  it("擦掉一笔的中段：两头各成一笔；撤销整笔回来，重做是同样的两段", () => {
    const h = mountSurface();
    writeLine(h);
    const [original] = strokesOf(h);
    h.surface.setTool(PARTIAL_SMALL);
    // 落点逻辑 x=500；小号半径 8 + 半笔宽 2 → 切掉 490–510
    tap(h, 150, 40);
    expect(xsOf(h)).toEqual([
      [333.33, 490],
      [510, 666.67],
    ]);
    expect(h.events.at(-1)).toEqual({ reason: "erase", strokes: 2 });
    const pieces = strokesOf(h);
    // 段是新笔画：各有自己的 id，其余属性照原笔画
    const ids = pieces.map((piece) => piece.id);
    expect(new Set([...ids, original?.id]).size).toBe(3);
    for (const piece of pieces) {
      expect(piece).toMatchObject({
        tool: "pen",
        color: original?.color,
        weight: original?.weight,
        pointer: "pen",
      });
    }

    h.surface.undo();
    expect(strokesOf(h)).toEqual([original]);
    expect(h.events.at(-1)).toEqual({ reason: "undo", strokes: 1 });
    h.surface.redo();
    expect(strokesOf(h)).toEqual(pieces);
  });

  it("一次拖动只记一个历史条目：连切两刀后撤销一次全部恢复", () => {
    const h = mountSurface();
    writeLine(h);
    const original = strokesOf(h);
    h.surface.setTool(PARTIAL_SMALL);
    // 先点在 x=130（逻辑 433.33），抬起到线外再落回 x=170（逻辑 566.67）
    pointer(h.canvas, "pointerdown", pd("pen", 1, 130, 40));
    pointer(h.canvas, "pointermove", { clientX: 130, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 170, clientY: 80 });
    pointer(h.canvas, "pointermove", { clientX: 170, clientY: 40 });
    // 拖动途中正文不变，抬起才提交
    expect(strokesOf(h)).toEqual(original);
    pointer(h.canvas, "pointerup", { clientX: 170, clientY: 40 });
    expect(xsOf(h)).toEqual([
      [333.33, 423.33],
      [443.33, 556.67],
      [576.67, 666.67],
    ]);
    expect(h.events.filter((event) => event.reason === "erase")).toHaveLength(
      1,
    );
    h.surface.undo();
    expect(strokesOf(h)).toEqual(original);
  });

  it("没带擦除方式的橡皮仍是整笔擦除", () => {
    const h = mountSurface();
    writeLine(h);
    h.surface.setTool({ type: "eraser", size: "small" });
    tap(h, 150, 40);
    expect(strokesOf(h)).toHaveLength(0);
  });

  it("擦除方式按落笔时为准：拖动途中改成整笔不影响这一次拖动", () => {
    const h = mountSurface();
    writeLine(h);
    h.surface.setTool(PARTIAL_SMALL);
    pointer(h.canvas, "pointerdown", pd("pen", 1, 150, 80));
    h.surface.setTool({ type: "eraser", mode: "stroke", size: "small" });
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 40 });
    pointer(h.canvas, "pointerup", { clientX: 150, clientY: 40 });
    expect(strokesOf(h)).toHaveLength(2);
  });

  it("拖动途中只重画改动的那一块：远处的笔画不重放，画布不整张清空", () => {
    const h = mountSurface();
    // 远处一笔 6 个采样点（重放要描 6 次）；近处横线 2 个采样点
    writeStroke(h, [
      { x: 20, y: 150 },
      { x: 30, y: 150 },
      { x: 40, y: 150 },
      { x: 50, y: 150 },
      { x: 60, y: 150 },
      { x: 70, y: 150 },
    ]);
    writeLine(h);
    h.surface.setTool(PARTIAL_SMALL);
    const clearRect = vi.spyOn(StubContext.prototype, "clearRect");
    const clip = vi.spyOn(StubContext.prototype, "clip");
    StubContext.strokeCalls = 0;
    pointer(h.canvas, "pointerdown", pd("pen", 1, 150, 40));
    // 只重放切剩的两段（各 2 个采样点）
    expect(StubContext.strokeCalls).toBe(4);
    expect(clip).toHaveBeenCalledTimes(1);
    expect(clearRect).toHaveBeenCalledTimes(1);
    const [x, y, width, height] = clearRect.mock
      .calls[0] as unknown as number[];
    // 画布 300×200：清空的矩形落在横线附近，远小于整张
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect((x ?? 0) + (width ?? 0)).toBeLessThan(300);
    expect((y ?? 0) + (height ?? 0)).toBeLessThan(120);
    // 没有改动的移动不重画
    clearRect.mockClear();
    StubContext.strokeCalls = 0;
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 41 });
    expect(clearRect).not.toHaveBeenCalled();
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: 150, clientY: 41 });
    clearRect.mockRestore();
    clip.mockRestore();
  });

  it("手掌先落用橡皮擦了一半、笔随后落下：手掌擦的不算数", () => {
    const h = mountSurface();
    writeLine(h);
    const original = strokesOf(h);
    h.surface.setTool(PARTIAL_SMALL);
    pointer(h.canvas, "pointerdown", pd("touch", 1, 150, 40));
    pointer(h.canvas, "pointerdown", pd("pen", 2, 150, 150));
    pointer(h.canvas, "pointerup", pd("pen", 2, 150, 150));
    expect(strokesOf(h)).toEqual(original);
    expect(h.events.filter((event) => event.reason === "erase")).toHaveLength(
      0,
    );
  });
});

describe("atrament-adapter：橡皮圈", () => {
  function ring(h: Harness): SVGElement {
    const node = h.container.querySelector<SVGElement>(
      INK_ERASER_RING_SELECTOR,
    );
    if (node === null) throw new Error("临时层缺少橡皮圈");
    return node;
  }
  const shown = (h: Harness) => ring(h).style.display !== "none";
  const at = (h: Harness) =>
    ["cx", "cy", "r"].map((name) => Number(ring(h).getAttribute(name)));

  it("按下显示在落点、半径是橡皮半径；拖动跟着走；抬起收起", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "eraser", size: "large" });
    expect(shown(h)).toBe(false);
    pointer(h.canvas, "pointerdown", pd("touch", 1, 30, 60));
    expect(shown(h)).toBe(true);
    expect(at(h)).toEqual([100, 200, 24]);
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      clientX: 90,
      clientY: 60,
    });
    expect(at(h)).toEqual([300, 200, 24]);
    pointer(h.canvas, "pointerup", {
      pointerType: "touch",
      clientX: 90,
      clientY: 60,
    });
    expect(shown(h)).toBe(false);
  });

  it("鼠标、笔悬停在纸上时（没按下）也显示橡皮圈；移出纸面收起", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "eraser", size: "small" });
    pointer(h.canvas, "pointermove", {
      pointerType: "mouse",
      buttons: 0,
      clientX: 60,
      clientY: 30,
    });
    expect(shown(h)).toBe(true);
    expect(at(h)).toEqual([200, 100, 8]);
    // 笔悬停同样显示橡皮圈，不再显示笔尖预览点
    pointer(h.canvas, "pointermove", {
      pointerType: "pen",
      buttons: 0,
      clientX: 90,
      clientY: 30,
    });
    expect(at(h)).toEqual([300, 100, 8]);
    const dot = h.container.querySelector<HTMLElement>("[data-slot=ink-hover]");
    expect(dot?.style.display).toBe("none");
    h.canvas.dispatchEvent(new PointerEvent("pointerleave"));
    expect(shown(h)).toBe(false);
  });

  it("不是橡皮时悬停不显示橡皮圈；从橡皮切到笔，圈立即收起", () => {
    const h = mountSurface();
    pointer(h.canvas, "pointermove", {
      pointerType: "mouse",
      buttons: 0,
      clientX: 60,
      clientY: 30,
    });
    expect(shown(h)).toBe(false);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointermove", {
      pointerType: "mouse",
      buttons: 0,
      clientX: 60,
      clientY: 30,
    });
    expect(shown(h)).toBe(true);
    h.surface.setTool({ type: "pen" });
    expect(shown(h)).toBe(false);
  });

  it("手指在纸上移动（没有按下的触摸不存在）不触发悬停圈；笔写字时不显示", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "pen" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 30 });
    expect(shown(h)).toBe(false);
    pointer(h.canvas, "pointerup", { clientX: 90, clientY: 30 });
    expect(shown(h)).toBe(false);
  });

  it("橡皮拖动被打断（尺寸变化）：按已擦的提交，橡皮圈收起", () => {
    const h = mountSurface();
    writeStroke(h, [
      { x: 100, y: 40 },
      { x: 200, y: 40 },
    ]);
    h.surface.setTool({ type: "eraser" });
    pointer(h.canvas, "pointerdown", pd("pen", 1, 150, 40));
    expect(shown(h)).toBe(true);
    h.resizeTo(600);
    expect(shown(h)).toBe(false);
    expect(strokesOf(h)).toHaveLength(0);
  });
});

describe("atrament-adapter：图形与直线荧光笔", () => {
  function livePath(h: Harness): Element {
    const path = h.container.querySelector(`${INK_LIVE_LAYER_SELECTOR} path`);
    if (path === null) throw new Error("临时层未挂载");
    return path;
  }
  /** 300 宽的画布：CSS 30 → 逻辑 100 */
  const RED_THIN_RECT = {
    type: "shape",
    shape: "rect",
    color: "red",
    size: "thin",
  } as const;

  it("拖动途中只在临时层上出预览，不往画布上画，文档不变", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    expect(livePath(h).hasAttribute("d")).toBe(false);
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 90 });
    const path = livePath(h);
    expect(path.getAttribute("d")).toBe(
      "M100 100L500 100L500 300L100 300L100 100",
    );
    expect(path.getAttribute("stroke")).toBe("#dc2626");
    expect(path.getAttribute("stroke-width")).toBe("2.5");
    expect(StubContext.strokeCalls).toBe(0);
    expect(strokesOf(h)).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("抬笔：落成一笔普通的笔（点都在图形上），画到画布，预览收起", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 90, y: 60 },
      { x: 150, y: 90 },
    ]);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    const strokes = strokesOf(h);
    expect(strokes).toHaveLength(1);
    const stroke = strokes[0];
    expect(stroke).toMatchObject({
      tool: "pen",
      color: "#dc2626",
      weight: 2.5,
      pointer: "pen",
    });
    expect(stroke?.id).toEqual(expect.any(String));
    expect(stroke?.startedAt).toEqual(expect.any(Number));
    expect(stroke?.points[0]).toMatchObject({ x: 100, y: 100, p: 0.51, t: 0 });
    expect(stroke?.points.at(-1)).toMatchObject({ x: 100, y: 100 });
    // 矩形周长 1200 个逻辑单位、间距 4：三百来个点，全在四条边上
    expect(stroke?.points.length).toBeGreaterThan(300);
    for (const p of stroke?.points ?? []) {
      const onEdge = p.x === 100 || p.x === 500 || p.y === 100 || p.y === 300;
      expect(onEdge).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(100);
      expect(p.x).toBeLessThanOrEqual(500);
      expect(p.y).toBeGreaterThanOrEqual(100);
      expect(p.y).toBeLessThanOrEqual(300);
    }
    expect(StubContext.strokeCalls).toBeGreaterThan(0);
    expect(h.events).toEqual([{ reason: "stroke", strokes: 1 }]);
  });

  it("图形是一步历史：撤销整个拿掉，重做整个回来", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "ellipse" });
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 150, y: 90 },
    ]);
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points.length).toBeGreaterThan(100);
    h.surface.undo();
    expect(strokesOf(h)).toHaveLength(0);
    h.surface.redo();
    expect(strokesOf(h)).toHaveLength(1);
  });

  it("直线接近水平时吸附；箭头是一笔", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "line" });
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 150, y: 33 },
    ]);
    expect(strokesOf(h)[0]?.points.every((p) => p.y === 100)).toBe(true);
    expect(strokesOf(h)[0]?.points.at(-1)).toMatchObject({ x: 500, y: 100 });

    h.surface.setTool({ type: "shape", shape: "arrow" });
    writeStroke(h, [
      { x: 30, y: 90 },
      { x: 150, y: 150 },
    ]);
    expect(strokesOf(h)).toHaveLength(2);
    // 箭尖经过两次（杆到箭尖、从一侧箭翼折回）
    const tip = strokesOf(h)[1]?.points.filter(
      (p) => p.x === 500 && p.y === 500,
    );
    expect(tip).toHaveLength(4);
  });

  it("只点一下或拖得太短：不落笔，不发变更，预览收起", () => {
    const h = mountSurface();
    h.surface.setTool(RED_THIN_RECT);
    writeStroke(h, [{ x: 30, y: 30 }]);
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 31, y: 30 },
    ]);
    expect(strokesOf(h)).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(livePath(h).hasAttribute("d")).toBe(false);
    expect(h.surface.canUndo()).toBe(false);
  });

  it("拖出纸外：只画到纸边，点不出界", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "arrow" });
    writeStroke(h, [
      { x: 150, y: 100 },
      { x: 500, y: -60 },
    ]);
    const points = strokesOf(h)[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeGreaterThanOrEqual(0);
      // 300×200 的画布：逻辑高 666.67
      expect(p.y).toBeLessThanOrEqual(666.67);
    }
  });

  it("落笔后中途换成笔：这一笔仍按落笔时的图形画完", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "line" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    h.surface.setTool({ type: "pen" });
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 90 });
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: 150, clientY: 90 });
    const points = strokesOf(h)[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(50);
    expect(points.at(-1)).toMatchObject({ x: 500, y: 300 });
  });

  it("尺寸变化：在途图形按拖到的位置落笔，预览收起", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "line" });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 30 });
    h.resizeTo(600);
    expect(strokesOf(h)).toHaveLength(1);
    // 400 个逻辑单位、间距 4：100 步，连起点和终点补的一个点共 102 点
    expect(strokesOf(h)[0]?.points).toHaveLength(102);
    expect(strokesOf(h)[0]?.points.at(-1)).toMatchObject({ x: 500, y: 100 });
    expect(livePath(h).hasAttribute("d")).toBe(false);
  });

  it("手掌先落、笔后落：手掌拖出的图形丢弃，不进文档", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "shape", shape: "rect" });
    pointer(h.canvas, "pointerdown", pd("touch", 1, 30, 30));
    pointer(h.canvas, "pointermove", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 150,
      clientY: 90,
    });
    expect(livePath(h).hasAttribute("d")).toBe(true);
    pointer(h.canvas, "pointerdown", pd("pen", 2, 60, 60));
    expect(livePath(h).hasAttribute("d")).toBe(false);
    expect(strokesOf(h)).toHaveLength(0);
    pointer(h.canvas, "pointermove", {
      pointerId: 2,
      clientX: 120,
      clientY: 120,
    });
    pointer(h.canvas, "pointerup", pd("pen", 2, 120, 120));
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]?.points[0]).toMatchObject({ x: 200, y: 200 });
  });

  it("直线荧光笔：预览和落笔都是一条直线，落成只有起止两点的荧光笔笔画", () => {
    const h = mountSurface();
    h.surface.setTool({
      type: "highlighter",
      color: "pink",
      size: "thin",
      straight: true,
    });
    pointer(h.canvas, "pointerdown", { clientX: 30, clientY: 30 });
    pointer(h.canvas, "pointermove", { clientX: 90, clientY: 45 });
    pointer(h.canvas, "pointermove", { clientX: 150, clientY: 33 });
    expect(livePath(h).getAttribute("d")).toBe("M100 100L500 100");
    expect(livePath(h).getAttribute("stroke")).toBe(
      INK_HIGHLIGHTER_COLORS.pink,
    );
    expect(StubContext.strokeCalls).toBe(0);
    pointer(h.canvas, "pointerup", { clientX: 150, clientY: 33 });
    expect(strokesOf(h)).toHaveLength(1);
    expect(strokesOf(h)[0]).toMatchObject({
      tool: "highlighter",
      color: INK_HIGHLIGHTER_COLORS.pink,
      weight: INK_HIGHLIGHTER_SIZES.thin,
    });
    expect(strokesOf(h)[0]?.points.map(({ x, y, p }) => ({ x, y, p }))).toEqual(
      [
        { x: 100, y: 100, p: 0.51 },
        { x: 500, y: 100, p: 0.51 },
      ],
    );
    // 整笔一次描边
    expect(StubContext.strokeCalls).toBe(1);
  });

  it("不带直线选项的荧光笔照旧是手写轨迹", () => {
    const h = mountSurface();
    h.surface.setTool({ type: "highlighter" });
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 90, y: 45 },
      { x: 150, y: 33 },
    ]);
    expect(strokesOf(h)[0]?.points).toHaveLength(3);
  });

  it("手感配置下：图形不带画法参数（按标准平滑重放，拐角不被抹圆）；直线荧光笔与手写荧光笔一样带上", () => {
    const rendering: InkRendering = {
      renderer: "atrament",
      smoothing: 0.9,
      thinning: 0.35,
      streamline: 0.15,
      sizeScale: 1,
      simulatePressure: false,
    };
    const h = mountSurface({ rendering });
    h.surface.setTool({ type: "pen" });
    writeStroke(h, [
      { x: 30, y: 30 },
      { x: 90, y: 30 },
    ]);
    h.surface.setTool({ type: "shape", shape: "rect" });
    writeStroke(h, [
      { x: 30, y: 60 },
      { x: 150, y: 120 },
    ]);
    h.surface.setTool({ type: "highlighter", straight: true });
    writeStroke(h, [
      { x: 30, y: 150 },
      { x: 150, y: 150 },
    ]);
    const [pen, shape, highlighter] = strokesOf(h);
    expect(pen?.rendering).toMatchObject({ renderer: "atrament" });
    expect(shape?.rendering).toBeUndefined();
    expect(highlighter?.rendering).toMatchObject({ renderer: "atrament" });
  });
});
