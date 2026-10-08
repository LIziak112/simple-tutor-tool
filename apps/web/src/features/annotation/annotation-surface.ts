/**
 * 标注画布适配器（T6R.20，方案 §10「固定底图＋独立矢量标注」＋§4.1 输入
 * 状态机纪律）：底图上的圈画书写面。
 *
 * 与 ink engine 的关系（计划决策 6 的落地口径）：
 * - **复用**（不重写）：pointer-machine.ts 输入状态机（第二指针/
 *   pointercancel/lostpointercapture/失焦/布局变化全矩阵）、InkStore 历史、
 *   erase.ts 整笔橡皮、bounds.ts、atrament 程序化绘制原语（绘制路径与实时
 *   书写/重放/草稿渲染同一实现）；
 * - **标注专用画布**（非改 atrament-adapter）：InkDoc 的 width=1000 纸不
 *   变量是契约锁定（inkDocSchema 字面量），标注坐标域=底图像素坐标
 *   （AnnotationDoc），坐标系不同——适配器层独立、引擎件全共用；
 * - 画布策略：backing store 恒 = baseWidth×baseHeight（底图像素域），CSS
 *   尺寸随容器（底图 img 同盒）——旋转/resize 只影响指针→底图的换算比例，
 *   **不重设位图不重绘**（旧圈相对底图锚点像素位置天然不变）；
 * - 指针绑定直接挂画布元素（§4.1：不依赖 event.target.closest 穿透——
 *   中间层插入/事件目标被替换不影响收点，坐标一律取 getBoundingClientRect
 *   + clientX/Y）；
 * - 输入热路径只收点与轻量绘制；JSON/PNG 不在 pointermove 中执行（§4.2）。
 *
 * 🧑 真机待确认（R6）：iPad 圈画手感、手掌/笔先落后写、书写中途旋转收笔
 * 手感——决策矩阵在 pointer-machine.test.ts 锁定，手感不可静态审查替代。
 */
import Atrament from "atrament";
import { type StrokeBounds, strokeBounds } from "@/features/ink/engine/bounds.ts";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter.ts";
import { eraseHit } from "@/features/ink/engine/erase.ts";
import { InkStore } from "@/features/ink/engine/history.ts";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  observeStylusTouch,
  type PointerMachineEvent,
  type PointerMachineState,
  touchActionForInput,
} from "@/features/ink/engine/pointer-machine.ts";
import type { InkChangeReason } from "@/features/ink/engine/surface.ts";
import {
  INK_ERASE_RADIUS,
  INK_LOGICAL_WIDTH,
  type InkInputMode,
  type InkStroke,
  type InkStrokePoint,
  type InkToolConfig,
  resolveToolSpec,
} from "@/features/ink/engine/types.ts";
import type { AnnotationDoc } from "@tutor/contract";

/** 标注画布的 DOM 标识（E2E/注入器定位用；风格对齐 INK_CANVAS_DATA_SLOT） */
export const ANNOTATION_CANVAS_DATA_SLOT = "annotation-canvas";
export const ANNOTATION_CANVAS_SELECTOR = `canvas[data-slot="${ANNOTATION_CANVAS_DATA_SLOT}"]`;

/** 保留 2 位小数（底图坐标域 1440 宽下约 0.01px 精度，同引擎口径） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface AnnotationSurface {
  mount(el: HTMLElement, initial?: AnnotationDoc): void;
  getDoc(): AnnotationDoc;
  load(doc: AnnotationDoc): void;
  undo(): void;
  redo(): void;
  clear(): void;
  setTool(tool: InkToolConfig): void;
  canUndo(): boolean;
  canRedo(): boolean;
  onChange(
    cb: (doc: AnnotationDoc, reason: InkChangeReason) => void,
  ): () => void;
  destroy(): void;
}

export interface AnnotationSurfaceOptions {
  /** 底图像素宽（AnnotationDoc.baseWidth；backing store 与坐标域同值） */
  baseWidth: number;
  /** 底图像素高 */
  baseHeight: number;
  /** 输入模式（缺省 auto——笔/手指/鼠标都可圈画，同旧作答组件口径） */
  inputMode?: InkInputMode;
}

/**
 * 逻辑单位（1000 纸基准）→ 底图像素域的换算：笔粗/橡皮半径等引擎常量按
 * 底图宽度等比换算（视觉粗细与 1000 宽草稿纸同档）。
 */
function logicalToBase(baseWidth: number, value: number): number {
  return round2((value / INK_LOGICAL_WIDTH) * baseWidth);
}

/**
 * 在底图像素域内按一笔重放（atrament 官方程序化绘制；CSS 坐标桥接）。
 *
 * atrament 以 **CSS 单位**收点与线宽，内部乘 canvas.width/offsetWidth 落
 * 位图。cssPerBase = CSS 像素/底图像素：坐标 base×cssPerBase、线宽
 * weight_base×cssPerBase 交给 atrament 后，净落位图值 = 原底图像素值。
 */
export function replayAnnotationStroke(
  atrament: Atrament,
  cssPerBase: number,
  s: InkStroke,
): void {
  if (s.points.length === 0) return;
  atrament.color = s.color;
  atrament.weight = s.weight * cssPerBase;
  const first = s.points[0];
  if (!first) return;
  const sx = first.x * cssPerBase;
  const sy = first.y * cssPerBase;
  atrament.beginStroke(sx, sy);
  let prev = atrament.draw(sx, sy, sx, sy, first.p);
  for (let i = 1; i < s.points.length; i++) {
    const pt = s.points[i];
    if (!pt) continue;
    const x = pt.x * cssPerBase;
    const y = pt.y * cssPerBase;
    prev = atrament.draw(x, y, prev.x, prev.y, pt.p);
  }
  atrament.endStroke(prev.x, prev.y);
}

export function createAnnotationSurface(
  options: AnnotationSurfaceOptions,
): AnnotationSurface {
  const { baseWidth, baseHeight } = options;
  const store = new InkStore();

  let container: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let atrament: Atrament | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let observer: ResizeObserver | null = null;

  let tool: InkToolConfig = { type: "pen" };
  let base: { color: "black" | "blue" | "red"; size: "thin" | "medium" | "thick" } = {
    color: "red",
    size: "medium",
  };

  let machine: PointerMachineState = createPointerMachineState(
    options.inputMode ?? "auto",
  );

  let livePoints: InkStrokePoint[] = [];
  let liveStartStamp = 0;
  let liveTool: "pen" | "highlighter" = "pen";
  let liveBrush: { color: string; weight: number } | null = null;
  let liveStrokeIsErase = false;
  let livePrev: { x: number; y: number } | null = null;
  let pendingErase = new Set<number>();

  let reasonOverride: InkChangeReason | null = null;
  store.subscribe(() => {
    const reason = reasonOverride ?? "stroke";
    reasonOverride = null;
    notifyListeners(reason);
  });

  const changeListeners = new Set<
    (doc: AnnotationDoc, reason: InkChangeReason) => void
  >();
  function notifyListeners(reason: InkChangeReason): void {
    for (const cb of changeListeners) cb(getDoc(), reason);
  }
  function withReason<T>(reason: InkChangeReason, action: () => T): T {
    reasonOverride = reason;
    try {
      return action();
    } finally {
      reasonOverride = null;
    }
  }

  function getDoc(): AnnotationDoc {
    return {
      version: 1,
      baseWidth,
      baseHeight,
      strokes: store.getStrokes(),
    };
  }

  // ---- 坐标换算（§4.1：不依赖 event.target——rect 取画布、坐标取 client） ----

  /** CSS 像素/底图像素（指针→底图与底图→CSS 共用同一比例） */
  function cssPerBase(): number {
    const rect = canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 1;
    return rect.width / baseWidth;
  }

  /** 指针事件 → 底图像素坐标（钳制在域内：出界采样不入矢量，服务端域校验前置） */
  function eventToBase(
    ev: { clientX: number; clientY: number },
    rect?: DOMRect | null,
  ): { x: number; y: number } {
    const r = rect ?? canvas?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) {
      return { x: 0, y: 0 };
    }
    const scale = baseWidth / r.width;
    const yScale = baseHeight / r.height;
    const x = Math.min(baseWidth, Math.max(0, (ev.clientX - r.left) * scale));
    const y = Math.min(baseHeight, Math.max(0, (ev.clientY - r.top) * yScale));
    return { x: round2(x), y: round2(y) };
  }

  /** 底图像素 → atrament 的 CSS 坐标（atrament 内部再 ×canvas.width/offsetWidth） */
  function baseToCss(p: { x: number; y: number }): { x: number; y: number } {
    const rect = canvas?.getBoundingClientRect();
    const cssW = rect && rect.width > 0 ? rect.width : baseWidth;
    const cssH = rect && rect.height > 0 ? rect.height : baseHeight;
    return { x: (p.x / baseWidth) * cssW, y: (p.y / baseHeight) * cssH };
  }

  function pressureOf(ev: PointerEvent): number {
    return ev.pressure > 0 ? ev.pressure : 0.5;
  }

  let lastTouchAction: "pan-y" | "none" | null = null;
  function applyTouchAction(): void {
    const mode = touchActionForInput(
      machine.mode,
      machine.penObserved,
      tool.type === "scroll",
    );
    if (mode === lastTouchAction) return;
    lastTouchAction = mode;
    if (canvas) canvas.style.touchAction = mode;
    if (container) container.style.touchAction = mode;
  }

  function resetContext(): void {
    const c = ctx2d;
    if (!c) return;
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    c.lineCap = "round";
    c.lineJoin = "round";
  }

  /** 全量重绘（undo/redo/erase/load 后）：清位图 → 逐笔重放（跳过待擦除） */
  function redraw(): void {
    const c = ctx2d;
    const a = atrament;
    if (!c || !canvas || !a) return;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.restore();
    resetContext();
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width > 0 ? rect.width : baseWidth;
    const scale = cssW / baseWidth;
    store.peekStrokes().forEach((s, i) => {
      if (!pendingErase.has(i)) replayAnnotationStroke(a, scale, s);
    });
  }

  function abortLiveStroke(): void {
    if (livePrev && atrament) {
      atrament.endStroke(livePrev.x, livePrev.y);
    }
    livePoints = [];
    livePrev = null;
    liveStrokeIsErase = false;
    pendingErase = new Set();
    redraw();
  }

  /** 收笔：按已收真实采样提交（不补造终点；落笔快照分派，同引擎口径） */
  function commitLiveStroke(): void {
    if (liveStrokeIsErase) {
      if (pendingErase.size > 0) {
        withReason("erase", () => store.commitErase([...pendingErase]));
      }
      redraw();
    } else if (livePoints.length > 0 && liveBrush) {
      if (atrament && livePrev) {
        atrament.endStroke(livePrev.x, livePrev.y);
      }
      const brush = liveBrush;
      const points = livePoints;
      withReason("stroke", () =>
        store.commitAdd([
          {
            tool: liveTool,
            color: brush.color,
            weight: brush.weight, // 底图像素域（契约：weight 与坐标同域）
            points,
          },
        ]),
      );
    }
    livePoints = [];
    livePrev = null;
    liveStrokeIsErase = false;
    pendingErase = new Set();
  }

  // ---- 事件处理（接线同 atrament-adapter；坐标域换为底图像素） ----

  function onPointerDown(e: PointerEvent): void {
    if (tool.type === "scroll") return;
    const { x, y } = eventToBase(e);
    const rect = canvas?.getBoundingClientRect();
    const inBounds =
      rect !== undefined &&
      rect !== null &&
      e.clientX >= rect.left &&
      e.clientY >= rect.top &&
      e.clientX <= rect.right &&
      e.clientY <= rect.bottom;
    const r = advancePointerMachine(machine, {
      kind: "pointerdown",
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      inBounds,
    });
    machine = r.state;
    let started = false;
    for (const d of r.decisions) {
      if (d.action === "discard") abortLiveStroke();
      if (d.action === "commit") commitLiveStroke();
      if (d.action === "start") started = true;
    }
    applyTouchAction();
    if (!started) return;

    try {
      canvas?.setPointerCapture(e.pointerId);
    } catch {
      // 个别浏览器 canvas 未聚焦时可能抛错（同引擎口径）
    }
    liveStartStamp = e.timeStamp;
    liveStrokeIsErase = tool.type === "eraser";

    if (liveStrokeIsErase) {
      pendingErase = new Set(
        eraseHit(
          store.peekStrokes(),
          x,
          y,
          logicalToBase(baseWidth, INK_ERASE_RADIUS),
        ),
      );
      redraw();
      return;
    }

    const resolved = resolveToolSpec(tool, base);
    base = resolved.base;
    liveTool = tool.type === "highlighter" ? "highlighter" : "pen";
    if (!resolved.brush) return;
    // 引擎档位按 1000 纸基准定义 → 底图像素域等比换算（视觉粗细同档）
    liveBrush = {
      color: resolved.brush.color,
      weight: logicalToBase(baseWidth, resolved.brush.weight),
    };
    if (!atrament) return;
    atrament.color = liveBrush.color;
    atrament.weight = liveBrush.weight * cssPerBase();
    const start = baseToCss({ x, y });
    atrament.beginStroke(start.x, start.y);
    const p = pressureOf(e);
    livePrev = atrament.draw(start.x, start.y, start.x, start.y, p);
    livePoints = [{ x, y, p, t: 0 }];
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isSampleMove(machine, e.pointerId)) return;
    const rect = canvas?.getBoundingClientRect();
    let coalesced: PointerEvent[] = [];
    if (typeof e.getCoalescedEvents === "function") {
      coalesced = e.getCoalescedEvents();
    }
    const events = coalesced.length > 0 ? coalesced : [e];

    let eraseView: readonly InkStroke[] | null = null;
    let eraseBoxes: Array<StrokeBounds | null> | null = null;
    if (liveStrokeIsErase) {
      eraseView = store.peekStrokes();
      eraseBoxes = eraseView.map((s) => strokeBounds(s));
    }

    const radius = logicalToBase(baseWidth, INK_ERASE_RADIUS);
    for (const ev of events) {
      const { x, y } = eventToBase(ev, rect);
      if (eraseView && eraseBoxes) {
        const hits = eraseHit(eraseView, x, y, radius, eraseBoxes);
        let changed = false;
        for (const h of hits) {
          if (!pendingErase.has(h)) {
            pendingErase.add(h);
            changed = true;
          }
        }
        if (changed) redraw();
        continue;
      }
      if (!atrament || !liveBrush) continue;
      const p = pressureOf(ev);
      const prev = livePrev ?? baseToCss({ x, y });
      const at = baseToCss({ x, y });
      const processed = atrament.draw(at.x, at.y, prev.x, prev.y, p);
      livePrev = processed;
      livePoints.push({
        x,
        y,
        p,
        t: Math.max(0, Math.round(ev.timeStamp - liveStartStamp)),
      });
    }
  }

  function finishPointer(event: PointerMachineEvent): void {
    const r = advancePointerMachine(machine, event);
    machine = r.state;
    for (const d of r.decisions) {
      if (d.action === "commit") commitLiveStroke();
    }
  }

  function onPointerUp(e: PointerEvent): void {
    finishPointer({ kind: "pointerup", pointerId: e.pointerId });
  }
  function onPointerCancel(e: PointerEvent): void {
    finishPointer({ kind: "pointercancel", pointerId: e.pointerId });
  }
  function onLostPointerCapture(e: PointerEvent): void {
    finishPointer({ kind: "lostpointercapture", pointerId: e.pointerId });
  }
  function onWindowBlur(): void {
    finishPointer({ kind: "blur" });
  }
  function onVisibilityChange(): void {
    if (document.hidden) finishPointer({ kind: "blur" });
  }

  function anyStylusTouch(
    touches: TouchList | Array<{ touchType?: string }> | undefined,
  ): boolean {
    if (touches === undefined) return false;
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      if (t?.touchType === "stylus") return true;
    }
    return false;
  }

  function onTouchStart(e: TouchEvent): void {
    if (!anyStylusTouch(e.changedTouches) && !anyStylusTouch(e.touches)) {
      return;
    }
    machine = observeStylusTouch(machine);
    applyTouchAction();
    e.preventDefault();
  }
  function onTouchMove(e: TouchEvent): void {
    if (anyStylusTouch(e.changedTouches) || anyStylusTouch(e.touches)) {
      e.preventDefault();
    }
  }
  function onContextMenu(e: Event): void {
    e.preventDefault();
  }
  function onSelectStart(e: Event): void {
    e.preventDefault();
  }

  // ---- 实现 ----

  const surface: AnnotationSurface = {
    mount(el: HTMLElement, initial?: AnnotationDoc): void {
      container = el;
      el.style.position = "relative";
      el.style.width = "100%";
      // 容器高随宽等比（底图宽高比）——画布 CSS 盒与底图 img 同尺寸
      el.style.aspectRatio = `${baseWidth} / ${baseHeight}`;
      el.style.overflow = "hidden";
      el.style.userSelect = "none";
      el.style.setProperty("-webkit-user-select", "none");
      el.style.setProperty("-webkit-touch-callout", "none");

      canvas = document.createElement("canvas");
      canvas.setAttribute("data-slot", ANNOTATION_CANVAS_DATA_SLOT);
      // backing store 恒 = 底图像素域（resize 不重设位图——旧圈不重绘不漂移）
      canvas.width = baseWidth;
      canvas.height = baseHeight;
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      canvas.style.cursor = "crosshair";
      el.appendChild(canvas);

      ctx2d = canvas.getContext("2d");
      if (!ctx2d) {
        throw new Error("无法创建 canvas 2d 上下文（当前环境不支持）");
      }
      atrament = createProgrammaticAtrament(canvas);
      applyTouchAction();

      if (initial) {
        withReason("load", () => store.replace(initial.strokes));
      }
      redraw();

      // 指针直接绑画布元素（§4.1：不依赖 event.target.closest 穿透）
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("lostpointercapture", onLostPointerCapture);
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("selectstart", onSelectStart);
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);

      // 布局变化（旋转/resize）：在途一笔先按已收点收笔（不混用两个坐标
      // 变换）；位图恒定无需重设——CSS 缩放由浏览器完成
      observer = new ResizeObserver(() => {
        finishPointer({ kind: "layoutchange" });
      });
      observer.observe(el);
    },

    getDoc,

    load(doc: AnnotationDoc): void {
      finishPointer({ kind: "layoutchange" });
      withReason("load", () => store.replace(doc.strokes));
      redraw();
    },

    undo(): void {
      withReason("undo", () => store.undo());
      redraw();
    },
    redo(): void {
      withReason("redo", () => store.redo());
      redraw();
    },
    clear(): void {
      withReason("clear", () => store.commitClear());
      redraw();
    },

    setTool(next: InkToolConfig): void {
      tool = next;
      const resolved = resolveToolSpec(next, base);
      base = resolved.base;
      applyTouchAction();
    },

    canUndo(): boolean {
      return store.canUndo();
    },
    canRedo(): boolean {
      return store.canRedo();
    },

    onChange(
      cb: (doc: AnnotationDoc, reason: InkChangeReason) => void,
    ): () => void {
      changeListeners.add(cb);
      return () => {
        changeListeners.delete(cb);
      };
    },

    destroy(): void {
      observer?.disconnect();
      observer = null;
      changeListeners.clear();
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
        canvas.removeEventListener("touchstart", onTouchStart);
        canvas.removeEventListener("touchmove", onTouchMove);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("selectstart", onSelectStart);
      }
      atrament?.destroy();
      atrament = null;
      ctx2d = null;
      canvas?.remove();
      canvas = null;
      container = null;
    },
  };

  return surface;
}
