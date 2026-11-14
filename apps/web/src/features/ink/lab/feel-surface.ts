import {
  DEFAULT_INK_PROFILE_CONFIG,
  type InkStroke,
  type InkStrokePoint,
  type NoteBackground,
} from "@tutor/contract";
import type Atrament from "atrament";
import {
  createProgrammaticAtrament,
  replayAtramentStroke,
} from "../engine/atrament-replay";
import { canvasToPngBlob } from "../engine/canvas-png";
import { buildAtramentDoc, parseAtramentDoc } from "../engine/doc";
import { createEraseGesture, type ErasePoint } from "../engine/erase-gesture";
import { paintFreehandStroke } from "../engine/freehand-paint";
import { InkStore, mintStrokeId } from "../engine/history";
import { createInkLiveLayer, type InkLiveLayer } from "../engine/live-layer";
import {
  NOTE_PAPER_GRID_SPACING_LOGICAL,
  paperBackgroundCss,
} from "../engine/paper-style";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  observeStylusTouch,
  type PointerMachineEvent,
  touchActionForInput,
} from "../engine/pointer-machine";
import { PAINT_SPREAD_CSS } from "../engine/region-redraw";
import type { InkChangeReason, ToolAwareSurface } from "../engine/surface";
import {
  asPointerKind,
  INK_ERASE_RADIUS,
  type InkDoc,
  type InkInputMode,
  type InkPenBase,
  type InkPointerKind,
  type InkToolConfig,
  resolveGesture,
  resolveToolSpec,
} from "../engine/types";

/** 仅实验页使用，不改变正式作答的文档或渲染规则。 */
export interface FeelParams {
  thinning: number;
  smoothing: number;
  streamline: number;
  sizeScale: number;
  prediction: boolean;
  simulatePressure: boolean;
}
export const DEFAULT_FEEL_PARAMS: FeelParams = {
  thinning: 0.35,
  smoothing: 0.3,
  streamline: 0.15,
  sizeScale: 1,
  prediction: false,
  simulatePressure: false,
};
export const FEEL_PRESETS = [
  { label: "硬笔跟手", params: DEFAULT_FEEL_PARAMS },
  {
    label: "自然压感",
    params: {
      ...DEFAULT_FEEL_PARAMS,
      thinning: 0.6,
      smoothing: 0.55,
      streamline: 0.38,
    },
  },
  {
    label: "等宽标画",
    params: {
      ...DEFAULT_FEEL_PARAMS,
      thinning: 0,
      smoothing: 0.3,
      streamline: 0.1,
      prediction: false,
    },
  },
] as const;
export interface FeelStats {
  sampleRate: number;
  renderRate: number;
  livePoints: number;
  predictionPoints: number;
  rawSeen: boolean;
  coalescedSeen: boolean;
  predictedSeen: boolean;
  renderMs: number;
}
export interface FeelSurface extends ToolAwareSurface {
  setParams(params: FeelParams): void;
  getStats(): FeelStats;
}

/** 实验渲染器复用正式输入状态机与笔画仓；预测永远留在湿墨层。 */
export function createFeelSurface(
  initialParams = DEFAULT_FEEL_PARAMS,
  options: {
    store?: InkStore;
    background?: NoteBackground;
    preserveRendering?: boolean;
  } = {},
): FeelSurface {
  const store = options.store ?? new InkStore();
  let params = { ...initialParams };
  let machine = createPointerMachineState("pen");
  let tool: InkToolConfig = { type: "pen", color: "black", size: "medium" };
  let base: InkPenBase = { color: "black", size: "medium" };
  let host: HTMLElement | null = null;
  let dry: HTMLCanvasElement | null = null;
  let wet: HTMLCanvasElement | null = null;
  let dryCtx: CanvasRenderingContext2D | null = null;
  let replayBrush: Atrament | null = null;
  let wetCtx: CanvasRenderingContext2D | null = null;
  let observer: ResizeObserver | null = null;
  let width = 500;
  let height = 400;
  let enabled = true;
  let frame: number | null = null;
  let predictionTimer: ReturnType<typeof setTimeout> | null = null;
  let live: InkStroke | null = null;
  let predicted: InkStrokePoint[] = [];
  let startStamp = 0;
  let lastStamp = -Infinity;
  // LR-1：本笔绝对时刻与输入来源（pointerdown 捕获，随笔画提交）
  let liveStartedAt = 0;
  let livePointerKind: InkPointerKind | undefined;
  /** 橡皮圈画在这一层（盖在两块画布上，不接指针事件） */
  let ringLayer: InkLiveLayer | null = null;
  /**
   * 橡皮从落下到抬起的这一次擦除：拖动途中正文不动，抬起时一次提交。
   * 只有各笔保留自己画法时（正式手写）才只重画改动的那一块；实验页的调参
   * 会换掉全部笔画的画法，笔画自带的范围不作数，整张重画。
   */
  const eraser = createEraseGesture({
    repaintTarget: () =>
      options.preserveRendering && dry && dryCtx
        ? {
            context: dryCtx,
            canvas: dry,
            pixelsPerUnit: dry.width / 1000,
            spread: (PAINT_SPREAD_CSS * 1000) / width,
          }
        : null,
    paint: (item) => {
      if (dryCtx) paint(dryCtx, item.stroke, true);
    },
    redraw: redrawDry,
    ring: () => ringLayer,
  });
  let eraseRadius = INK_ERASE_RADIUS;
  let reason: InkChangeReason = "stroke";
  const samples: number[] = [];
  const renders: number[] = [];
  const stats: FeelStats = {
    sampleRate: 0,
    renderRate: 0,
    livePoints: 0,
    predictionPoints: 0,
    rawSeen: false,
    coalescedSeen: false,
    predictedSeen: false,
    renderMs: 0,
  };
  let finishCause: import("@tutor/contract").QuestionProcessFinish | undefined;
  const listeners = new Set<
    (
      doc: InkDoc,
      reason: InkChangeReason,
      finish?: import("@tutor/contract").QuestionProcessFinish,
    ) => void
  >();
  const unsubscribe = store.subscribe(() => {
    const doc = buildAtramentDoc(store);
    for (const cb of listeners) cb(doc, reason, finishCause);
  });
  function change(next: InkChangeReason, action: () => void) {
    reason = next;
    try {
      action();
    } finally {
      reason = "stroke";
    }
  }
  function clear(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function paint(
    ctx: CanvasRenderingContext2D,
    stroke: InkStroke,
    complete: boolean,
  ) {
    if (!dry || stroke.points.length === 0) return;
    const config = options.preserveRendering
      ? (stroke.rendering ?? DEFAULT_INK_PROFILE_CONFIG)
      : { ...params, renderer: "freehand" as const };
    if (config.renderer === "freehand") {
      paintFreehandStroke(ctx, dry.width / 1000, stroke, config, complete);
      return;
    }
    if (replayBrush) replayAtramentStroke(replayBrush, width, stroke);
    return;
  }
  function redrawDry() {
    if (!dry || !dryCtx) return;
    const context = dryCtx;
    clear(context, dry);
    // 擦除途中画的是预览（擦掉、切开之后的样子），正文要到抬起才改
    const preview = eraser.visible();
    if (preview) {
      for (const item of preview) paint(context, item.stroke, true);
      return;
    }
    for (const stroke of store.peekStrokes()) paint(context, stroke, true);
  }
  function clearWet() {
    if (predictionTimer !== null) clearTimeout(predictionTimer);
    predictionTimer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (wetCtx && wet) clear(wetCtx, wet);
    predicted = [];
  }
  function schedule() {
    if (frame !== null || !wet || !wetCtx) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!wet || !wetCtx) return;
      const started = performance.now();
      clear(wetCtx, wet);
      // 真点与预测只绘制一个轮廓，避免荧光笔重叠加深。
      if (live)
        paint(
          wetCtx,
          { ...live, points: [...live.points, ...predicted] },
          false,
        );
      stats.renderMs = performance.now() - started;
      renders.push(performance.now());
    });
  }
  function finishLive(
    discard = false,
    cause?: import("@tutor/contract").QuestionProcessFinish,
  ) {
    finishCause = cause;
    // 结果里的下标属于提交前的正文：先结束这次擦除，再提交、重画
    const erasing = eraser.active;
    const erased = eraser.end();
    if (!discard) {
      if (erased) {
        change("erase", () => store.commitErase(erased.removed, erased.added));
      } else if (live && live.points.length > 0) {
        const stroke = live;
        change("stroke", () => store.commitAdd([stroke]));
        if (dryCtx) paint(dryCtx, stroke, true);
      }
    }
    if (erasing) redrawDry();
    finishCause = undefined;
    live = null;
    clearWet();
  }
  function finish(event: PointerMachineEvent = { kind: "layoutchange" }) {
    const result = advancePointerMachine(machine, event);
    machine = result.state;
    for (const decision of result.decisions) {
      if (decision.action === "commit") {
        finishLive(false, decision.cause);
        if (wet?.hasPointerCapture?.(decision.pointerId))
          wet.releasePointerCapture(decision.pointerId);
      }
    }
  }
  function touchAction() {
    const action = touchActionForInput(
      machine.mode,
      machine.penObserved,
      tool.type === "scroll",
    );
    if (wet) wet.style.touchAction = action;
  }
  function point(
    event: Pick<PointerEvent, "clientX" | "clientY" | "pressure" | "timeStamp">,
    rect: DOMRect,
  ): InkStrokePoint {
    return {
      x: ((event.clientX - rect.left) / rect.width) * 1000,
      y: ((event.clientY - rect.top) / rect.width) * 1000,
      p: event.pressure > 0 ? event.pressure : 0.5,
      t: Math.max(0, event.timeStamp - startStamp),
    };
  }
  function down(event: PointerEvent) {
    if (!enabled || tool.type === "scroll" || !wet) return;
    const rect = wet.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const result = advancePointerMachine(machine, {
      kind: "pointerdown",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      inBounds: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height,
    });
    machine = result.state;
    touchAction();
    for (const decision of result.decisions) {
      if (decision.action === "discard") finishLive(true);
      if (decision.action === "commit") finishLive(false, decision.cause);
      if (decision.action !== "start") continue;
      startStamp = event.timeStamp;
      lastStamp = event.timeStamp;
      // LR-1：落笔绝对时刻（epoch ms）与输入来源（pointerType 直录）
      liveStartedAt = Date.now();
      livePointerKind = asPointerKind(event.pointerType);
      const first = point(event, rect);
      // 落笔快照：这一次手势按此刻的工具（含橡皮大小）分派
      const resolved = resolveGesture(tool, base);
      base = resolved.base;
      const gesture = resolved.gesture;
      if (gesture.kind === "erase") {
        eraseRadius = gesture.radius;
        eraser.begin(store.peekStrokes(), gesture.mode);
        eraser.through([{ x: first.x, y: first.y, radius: eraseRadius }]);
      } else {
        if (gesture.kind !== "draw") continue;
        live = {
          tool: gesture.tool,
          ...gesture.brush,
          // LR-1：笔画身份 + 落笔绝对时刻 + 输入来源（down 捕获）
          id: mintStrokeId(),
          ...(liveStartedAt > 0 ? { startedAt: liveStartedAt } : {}),
          ...(livePointerKind !== undefined
            ? { pointer: livePointerKind }
            : {}),
          rendering: {
            renderer: "freehand",
            smoothing: params.smoothing,
            thinning: params.thinning,
            streamline: params.streamline,
            sizeScale: params.sizeScale,
            simulatePressure: params.simulatePressure,
          },
          points: [first],
        };
        samples.push(performance.now());
        schedule();
      }
      try {
        wet.setPointerCapture(event.pointerId);
      } catch {
        /* 合成事件或浏览器不支持捕获时继续采样。 */
      }
    }
  }
  function move(event: PointerEvent) {
    if (!enabled || !wet) return;
    const rect = wet.getBoundingClientRect();
    if (rect.width <= 0) return;
    // 橡皮悬停（鼠标、笔，没按下）：显示橡皮圈，让人先看清擦多大一块
    if (
      machine.activePointerId === null &&
      event.buttons === 0 &&
      event.pointerType !== "touch"
    ) {
      const hover = resolveGesture(tool, base).gesture;
      if (hover.kind === "erase") {
        const at = point(event, rect);
        ringLayer?.showRing(at.x, at.y, hover.radius);
      }
    }
    if (!isSampleMove(machine, event.pointerId)) return;
    const batch = event.getCoalescedEvents?.() ?? [];
    if (batch.length > 0) stats.coalescedSeen = true;
    if (event.type === "pointerrawupdate") stats.rawSeen = true;
    let changed = false;
    const erasePoints: ErasePoint[] = [];
    for (const sample of batch.length > 0 ? batch : [event]) {
      const next = point(sample, rect);
      const previous = live?.points.at(-1);
      if (
        sample.timeStamp < lastStamp ||
        (sample.timeStamp === lastStamp &&
          previous?.x === next.x &&
          previous.y === next.y &&
          previous.p === next.p)
      )
        continue;
      lastStamp = sample.timeStamp;
      if (eraser.active) {
        erasePoints.push({ x: next.x, y: next.y, radius: eraseRadius });
      } else if (live) {
        live.points.push(next);
        samples.push(performance.now());
        changed = true;
      }
    }
    // 橡皮：一批采样记完再重画一次，橡皮圈跟到最后一个落点
    if (eraser.active) {
      eraser.through(erasePoints);
      return;
    }
    // raw 负责真实点也不抢占 move 的预测；只接受有界、短时的未来段。
    if (event.type === "pointermove") {
      if (predictionTimer !== null) clearTimeout(predictionTimer);
      predictionTimer = null;
      const previousPrediction = predicted.length;
      predicted = params.prediction
        ? (event.getPredictedEvents?.() ?? [])
            .filter(
              (p) =>
                p.timeStamp > lastStamp && p.timeStamp <= event.timeStamp + 32,
            )
            .slice(0, 8)
            .map((p) => point(p, rect))
            .filter(
              (p) =>
                p.x >= 0 &&
                p.x <= 1000 &&
                p.y >= 0 &&
                p.y <= (height / width) * 1000,
            )
        : [];
      if (predicted.length > 0) stats.predictedSeen = true;
      if (predicted.length > 0)
        predictionTimer = setTimeout(() => {
          predictionTimer = null;
          predicted = [];
          schedule();
        }, 32);
      changed ||= previousPrediction > 0 || predicted.length > 0;
    } else if (changed) {
      // 新真实点到达即丢弃过期预测，不等待下一次 move。
      predicted = [];
      if (predictionTimer !== null) clearTimeout(predictionTimer);
      predictionTimer = null;
    }
    if (changed) schedule();
  }
  const up = (e: PointerEvent) =>
    finish({ kind: "pointerup", pointerId: e.pointerId });
  const cancel = (e: PointerEvent) =>
    finish({ kind: "pointercancel", pointerId: e.pointerId });
  const lost = (e: PointerEvent) =>
    finish({ kind: "lostpointercapture", pointerId: e.pointerId });
  const blur = () => finish({ kind: "blur" });
  const visibility = () => {
    if (document.visibilityState === "hidden") blur();
  };
  /** 悬停留下的橡皮圈：指针离开画布、换了工具就收起（拖动中的由收笔收起） */
  const leave = () => {
    if (!eraser.active) ringLayer?.hideRing();
  };
  const prevent = (event: Event) => event.preventDefault();
  function touch(event: TouchEvent) {
    // 同时检查新触点与在屏触点，笔先落、手掌后落也不能触发滚动。
    for (const list of [event.changedTouches, event.touches]) {
      if (!list) continue;
      for (const item of Array.from(list)) {
        if ((item as Touch & { touchType?: string }).touchType === "stylus") {
          machine = observeStylusTouch(machine);
          touchAction();
          event.preventDefault();
          return;
        }
      }
    }
  }
  const bindings: Array<[string, EventListener]> = [
    ["pointerdown", down as EventListener],
    ["pointermove", move as EventListener],
    ["pointerrawupdate", move as EventListener],
    ["pointerup", up as EventListener],
    ["pointercancel", cancel as EventListener],
    ["lostpointercapture", lost as EventListener],
    ["pointerleave", leave],
    ["touchstart", touch as EventListener],
    ["touchmove", touch as EventListener],
    ["contextmenu", prevent],
    ["selectstart", prevent],
  ];
  function resize() {
    if (!host || !dry || !wet) return;
    const nextWidth = host.clientWidth || 500;
    const nextHeight = host.clientHeight || 400;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(nextWidth * dpr);
    const pixelHeight = Math.round(nextHeight * dpr);
    width = nextWidth;
    height = nextHeight;
    if (dry) {
      dry.style.backgroundImage = paperBackgroundCss(
        options.background ?? "white",
        width,
      );
      dry.style.backgroundSize = `${(NOTE_PAPER_GRID_SPACING_LOGICAL * width) / 1000}px ${(NOTE_PAPER_GRID_SPACING_LOGICAL * width) / 1000}px`;
    }
    // 橡皮圈所在的层与笔画同一坐标域：宽 1000、高按画布比例
    ringLayer?.setViewBox(1000, (height / width) * 1000);
    if (dry.width === pixelWidth && dry.height === pixelHeight) return;
    finish();
    for (const canvas of [dry, wet]) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    redrawDry();
  }
  return {
    mount(element, initial) {
      host = element;
      host.style.position = "relative";
      host.style.userSelect = "none";
      host.style.setProperty("-webkit-touch-callout", "none");
      dry = document.createElement("canvas");
      wet = document.createElement("canvas");
      dry.dataset.slot = "feel-dry";
      wet.dataset.slot = "feel-wet";
      for (const canvas of [dry, wet]) {
        Object.assign(canvas.style, {
          position: "absolute",
          inset: "0",
          width: "100%",
          height: "100%",
          display: "block",
        });
        host.append(canvas);
      }
      dry.style.pointerEvents = "none";
      dryCtx = dry.getContext("2d");
      if (options.preserveRendering)
        replayBrush = createProgrammaticAtrament(dry);
      wetCtx = wet.getContext("2d");
      if (!dryCtx || !wetCtx) throw new Error("浏览器无法创建手写画布");
      ringLayer = createInkLiveLayer(host);
      if (initial) {
        const parsedInitial = parseAtramentDoc(initial);
        store.replace(
          parsedInitial.strokes,
          initial.updatedAt,
          parsedInitial.deleted,
        );
      }
      resize();
      redrawDry();
      touchAction();
      for (const [name, listener] of bindings)
        wet.addEventListener(name, listener, { passive: false });
      window.addEventListener("blur", blur);
      document.addEventListener("visibilitychange", visibility);
      observer = new ResizeObserver(resize);
      observer.observe(host);
    },
    getDoc: () => buildAtramentDoc(store),
    load(doc) {
      finish();
      const parsedDoc = parseAtramentDoc(doc);
      change("load", () =>
        store.replace(parsedDoc.strokes, doc.updatedAt, parsedDoc.deleted),
      );
      redrawDry();
    },
    finish: () => finish(),
    setInputEnabled(next) {
      if (!next) finish();
      enabled = next;
      if (wet) wet.style.pointerEvents = next ? "auto" : "none";
    },
    setInputMode(mode: InkInputMode) {
      finish();
      machine = { ...machine, mode };
      touchAction();
    },
    setTool(next) {
      finish();
      tool = next;
      base = resolveToolSpec(next, base).base;
      touchAction();
      leave();
    },
    setParams(next) {
      finish();
      params = { ...next };
      redrawDry();
    },
    undo() {
      finish();
      change("undo", () => store.undo());
      redrawDry();
    },
    redo() {
      finish();
      change("redo", () => store.redo());
      redrawDry();
    },
    clear() {
      finish();
      change("clear", () => store.commitClear());
      redrawDry();
    },
    canUndo: () => store.canUndo(),
    canRedo: () => store.canRedo(),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getStats() {
      const now = performance.now();
      for (const times of [samples, renders])
        while (times[0] !== undefined && times[0] < now - 1000) times.shift();
      return {
        ...stats,
        sampleRate: samples.length,
        renderRate: renders.length,
        livePoints: live?.points.length ?? 0,
        predictionPoints: predicted.length,
      };
    },
    async exportPng() {
      finish();
      if (!dry) throw new Error("画布尚未就绪");
      const output = document.createElement("canvas");
      output.width = dry.width;
      output.height = dry.height;
      const ctx = output.getContext("2d");
      if (!ctx) throw new Error("导出图片失败");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, output.width, output.height);
      ctx.drawImage(dry, 0, 0);
      return canvasToPngBlob(output);
    },
    destroy() {
      finish();
      clearWet();
      observer?.disconnect();
      replayBrush?.destroy();
      replayBrush = null;
      unsubscribe();
      listeners.clear();
      if (wet)
        for (const [name, listener] of bindings)
          wet.removeEventListener(name, listener);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      ringLayer?.destroy();
      ringLayer = null;
      dry?.remove();
      wet?.remove();
      dry = null;
      wet = null;
      dryCtx = null;
      wetCtx = null;
      host = null;
    },
  };
}
