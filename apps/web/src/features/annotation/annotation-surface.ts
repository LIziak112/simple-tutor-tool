/**
 * 标注画布适配器（T6R.20，方案 §10「固定底图＋独立矢量标注」＋§4.1 输入
 * 状态机纪律）：底图上的圈画书写面。
 *
 * 与 ink engine 的关系（计划决策 6 的落地口径）：
 * - **复用**（不重写）：pointer-machine.ts 输入状态机（第二指针/
 *   pointercancel/lostpointercapture/失焦/布局变化全矩阵）、InkStore 历史、
 *   erase-gesture.ts 橡皮（整笔与局部）、touch-guards.ts 触摸防护、atrament
 *   程序化绘制原语（绘制路径与实时书写/重放/草稿渲染同一实现，一笔的重放
 *   在 annotation-replay.ts）；
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

import {
  ANNOTATION_MAX_DELETED_POINTS,
  ANNOTATION_MAX_DELETED_STROKES,
  ANNOTATION_MAX_STROKES,
  type AnnotationDoc,
  type AnnotationSurfaceCompatibility,
} from "@tutor/contract";
import type Atrament from "atrament";
import {
  anchorKeyForStroke,
  strokeBbox,
} from "@/features/annotation/annotation-anchor";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-replay.ts";
import { createEraseGesture } from "@/features/ink/engine/erase-gesture.ts";
import { isOnePathStroke } from "@/features/ink/engine/highlighter-paint.ts";
import { InkStore, mintStrokeId } from "@/features/ink/engine/history.ts";
import {
  createInkLiveLayer,
  type InkLiveLayer,
} from "@/features/ink/engine/live-layer.ts";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  observeStylusTouch,
  type PointerMachineEvent,
  type PointerMachineState,
  touchActionForInput,
} from "@/features/ink/engine/pointer-machine.ts";
import { PAINT_SPREAD_CSS } from "@/features/ink/engine/region-redraw.ts";
import { createShapeGesture } from "@/features/ink/engine/shape-gesture.ts";
import type { InkChangeReason } from "@/features/ink/engine/surface.ts";
import { createTouchGuards } from "@/features/ink/engine/touch-guards.ts";
import {
  asPointerKind,
  INK_LOGICAL_WIDTH,
  type InkInputMode,
  type InkPenBase,
  type InkPointerKind,
  type InkStroke,
  type InkStrokePoint,
  type InkToolConfig,
  resolveGesture,
  resolveToolSpec,
} from "@/features/ink/engine/types.ts";
import { replayAnnotationStrokes } from "./annotation-replay.ts";

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
  finish(): void;
  setInputEnabled(enabled: boolean): void;
  setInputMode(mode: InkInputMode): void;
  load(doc: AnnotationDoc): void;
  undo(): void;
  redo(): void;
  clear(): void;
  setTool(tool: InkToolConfig): void;
  canUndo(): boolean;
  canRedo(): boolean;
  onChange(
    cb: (
      doc: AnnotationDoc,
      reason: InkChangeReason,
      finish?: import("@tutor/contract").QuestionProcessFinish,
    ) => void,
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
  inputEnabled?: boolean;
  /**
   * LR-6：收笔锚定的布局证据（layout.compatibility.blocks，含 node 键）。
   * 由宿主（QuestionAnnotationOverlay）从底图行供给；缺省/无键块 → 不锚
   * （旧布局不伪造锚点，P1）。
   */
  anchorBlocks?:
    | (() => AnnotationSurfaceCompatibility["blocks"] | undefined)
    | undefined;
  /**
   * LR-PR4 第二层（近似原位 §5.4）：画布坐标域（视图域 = 当前实测布局的
   * 底图像素域）与文档存储域（保存底图域）不一致时的域视图垫片。存储域语义
   * 不变——InkStore、getDoc()、撤销/墓碑/压实全在存储域运转；垫片只在两处
   * 边界做整笔变换：重绘（存储→视图）与收笔提交（视图→存储，锚定后）。
   * 橡皮命中先把指针点映射回存储域再整笔命中（ratio 供半径同乘换算）。
   * 注意：anchorBlocks 在近似模式下须供给**视图域**块表（当前布局）；锚键
   * 为布局无关的节点键，两侧同键。
   */
  reprojectedView?: {
    /** 文档存储域尺寸（getDoc() 输出 baseWidth/baseHeight；= 保存底图域） */
    storedBaseWidth: number;
    storedBaseHeight: number;
    /**
     * 视图笔画 → 存储域（收笔提交；id/startedAt/pointer 等字段原样保留）。
     * unanchored=true 表示锚键不在保存块表（走了 root 兜底）——调用方不写
     * anchors（服务端锚校验会整次 400，评审 #12019 顺手项）。
     */
    strokeToStored(
      stroke: InkStroke,
      anchorKey: string | undefined,
    ): { stroke: InkStroke; unanchored: boolean };
    /** 存储笔画 → 视图（重绘显示；锚缺失走 root 兜底） */
    strokeToView(stroke: InkStroke, anchorKey: string | undefined): InkStroke;
    /** 视图点 → 存储点（橡皮指针命中；ratio = 局部存储/视图线比，半径同乘） */
    pointToStored(p: { x: number; y: number }): {
      x: number;
      y: number;
      ratio: number;
    };
  };
}

/**
 * 逻辑单位（1000 纸基准）→ 底图像素域的换算：笔粗/橡皮半径等引擎常量按
 * 底图宽度等比换算（视觉粗细与 1000 宽草稿纸同档）。
 */
function logicalToBase(baseWidth: number, value: number): number {
  return round2((value / INK_LOGICAL_WIDTH) * baseWidth);
}

export function createAnnotationSurface(
  options: AnnotationSurfaceOptions,
): AnnotationSurface {
  const {
    baseWidth,
    baseHeight,
    anchorBlocks,
    reprojectedView: view,
  } = options;
  // LR-2/LR-4：墓碑预算按圈画链（80k 点）；压实丢墓碑时同步清这些 id 的锚点
  const anchors: Record<string, string> = {};
  const store = new InkStore({
    maxDeletedPoints: ANNOTATION_MAX_DELETED_POINTS,
    // LR-2：圈画链墓碑按「笔数」压实——400 笔上限先于 80k 点撞顶，
    // 且 413 后 annotation-sync 判 denied 不再重试，客户端必须先压实
    maxDeletedStrokes: ANNOTATION_MAX_DELETED_STROKES,
    onTombstonesTrimmed: (trimmed) => {
      for (const tomb of trimmed) delete anchors[tomb.id];
    },
  });

  let container: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let atrament: Atrament | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  /** 书写中的荧光笔那一笔放在这一层，抬笔后整笔落到画布 */
  let liveLayer: InkLiveLayer | null = null;
  let observer: ResizeObserver | null = null;
  let inputBound = false;

  let tool: InkToolConfig = { type: "pen" };
  let base: InkPenBase = { color: "red", size: "medium" };

  let machine: PointerMachineState = createPointerMachineState(
    options.inputMode ?? "auto",
  );

  let livePoints: InkStrokePoint[] = [];
  let liveStartStamp = 0;
  // LR-1：本笔绝对时刻与输入来源（pointerdown 捕获，收笔随笔画提交）
  let liveStartedAt = 0;
  let livePointerKind: InkPointerKind | undefined;
  let liveTool: "pen" | "highlighter" = "pen";
  let liveBrush: { color: string; weight: number } | null = null;
  /** 本笔是否整笔一条路径（荧光笔）：书写中只在临时层上，不往画布逐段画 */
  let liveOnLayer = false;
  /**
   * 橡皮从落下到抬起的这一次擦除（落笔时按当时的工具开始，eraser.active 即
   * 本次手势是擦除）。拖动途中正文不动，抬起时一次提交。
   * 近似原位时笔画在存储域、画布在视图域，对不上：不做局部重画，整张重画。
   */
  const eraser = createEraseGesture({
    repaintTarget: () =>
      view || !ctx2d || !canvas
        ? null
        : {
            context: ctx2d,
            canvas,
            pixelsPerUnit: 1, // 位图恒 = 底图像素域
            spread: PAINT_SPREAD_CSS / cssPerBase(),
          },
    paint: (items) => {
      if (atrament)
        replayAnnotationStrokes(
          atrament,
          cssPerBase(),
          items.map((item) => item.stroke),
        );
    },
    redraw,
    ring: () => liveLayer,
  });
  /** 本次擦除的橡皮半径（底图像素域），取落笔时的档位 */
  let liveEraseRadius = 0;
  /**
   * 图形工具或直线荧光笔的这一次拖动：预览在临时层上（画布域），抬笔给出
   * 这一笔的点列。近似原位时和手写一样，整笔在视图域成形、提交前映射回去。
   */
  const shaper = createShapeGesture({ layer: () => liveLayer });
  let livePrev: { x: number; y: number } | null = null;

  let reasonOverride: InkChangeReason | null = null;
  let finishCause: import("@tutor/contract").QuestionProcessFinish | undefined;
  store.subscribe(() => {
    const reason = reasonOverride ?? "stroke";
    reasonOverride = null;
    try {
      notifyListeners(reason);
    } finally {
      finishCause = undefined;
    }
  });

  const changeListeners = new Set<
    (
      doc: AnnotationDoc,
      reason: InkChangeReason,
      finish?: import("@tutor/contract").QuestionProcessFinish,
    ) => void
  >();
  function notifyListeners(reason: InkChangeReason): void {
    for (const cb of changeListeners) cb(getDoc(), reason, finishCause);
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
    const strokes = store.getStrokes();
    const deleted = store.getDeleted();
    // 锚点只带正文与墓碑里有的笔画（服务端按此校验）：局部擦除被撤销后，
    // 切出来的段两边都不在；重做时它们原样回来，所以表里的键留着不删
    const known = new Set([...strokes, ...deleted].map((stroke) => stroke.id));
    const kept = Object.entries(anchors).filter(([id]) => known.has(id));
    return {
      version: 1,
      // 近似原位：文档恒在存储域（保存底图域），画布域（视图）只是显示
      baseWidth: view?.storedBaseWidth ?? baseWidth,
      baseHeight: view?.storedBaseHeight ?? baseHeight,
      strokes,
      // LR-2/LR-4：墓碑与锚点非空才写键（空稿/旧稿字节兼容）
      ...(deleted.length > 0 ? { deleted } : {}),
      ...(kept.length > 0 ? { anchors: Object.fromEntries(kept) } : {}),
    };
  }

  /**
   * 外部文档整组载入：正文、墓碑、锚点一起换（mount 恢复与 load 同口径）。
   * 修复：mount 原先只装 strokes——带墓碑/锚点的旧稿挂载后首次编辑会经
   * getDoc() 把它们静默写丢（LR-2/LR-4 数据缺陷）。
   */
  function adoptDoc(doc: AnnotationDoc): void {
    store.replace(doc.strokes, Date.now(), doc.deleted ?? []);
    for (const key of Object.keys(anchors)) delete anchors[key];
    Object.assign(anchors, doc.anchors ?? {});
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

  /** 这一笔的锚键（没有 id 或没锚过为 undefined） */
  function anchorOf(s: InkStroke | undefined): string | undefined {
    return s?.id === undefined ? undefined : anchors[s.id];
  }

  /** 全量重绘（undo/redo/erase/load 后）：清位图 → 按顺序重放（擦除途中画预览） */
  function redraw(): void {
    const c = ctx2d;
    const a = atrament;
    if (!c || !canvas || !a) return;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.restore();
    resetContext();
    const strokes = store.peekStrokes();
    // 近似原位：重绘在视图域画——存储笔画经锚映射到当前布局（锚缺失走 root）
    const inView = (s: InkStroke, anchorKey: string | undefined) =>
      view ? view.strokeToView(s, anchorKey) : s;
    const preview = eraser.visible();
    // 擦除途中：切剩的段还没有自己的锚点，按它出自的那一笔的锚映射。
    // 一串一起画：同一笔切出来的荧光笔各段合在一起上一次色
    replayAnnotationStrokes(
      a,
      cssPerBase(),
      preview
        ? preview.map((item) =>
            inView(item.stroke, anchorOf(strokes[item.source])),
          )
        : strokes.map((s) => inView(s, anchorOf(s))),
    );
  }

  /** 把书写中的整笔一条路径的那一笔（视图域）更新到临时层 */
  function showLiveStroke(): void {
    if (!liveBrush) return;
    liveLayer?.showStroke({ ...liveBrush, points: livePoints });
  }

  function abortLiveStroke(): void {
    if (livePrev && atrament) {
      atrament.endStroke(livePrev.x, livePrev.y);
    }
    finishCause = undefined;
    livePoints = [];
    livePrev = null;
    liveOnLayer = false;
    liveLayer?.clear();
    eraser.end();
    shaper.end();
    redraw();
  }

  /** 橡皮的一个落点（画布域）→ 擦除用的落点与橡皮圈的位置 */
  function erasePointOf(at: { x: number; y: number }) {
    // 近似原位：橡皮命中在存储域做——指针点先映射回存储域（ratio 供半径换算）
    const stored = view ? view.pointToStored(at) : { ...at, ratio: 1 };
    return {
      point: {
        x: stored.x,
        y: stored.y,
        radius: liveEraseRadius * stored.ratio,
      },
      ring: { ...at, radius: liveEraseRadius },
    };
  }

  /**
   * 把这一笔（画布域的点列）锚定、换算回存储域并提交。paintWhole：这一笔
   * 书写中不在画布上（整笔一条路径的笔、图形），提交前先整笔画上去。
   */
  function commitStroke(
    brush: { color: string; weight: number },
    points: InkStroke["points"],
    paintWhole: boolean,
  ): void {
    if (atrament && livePrev) {
      atrament.endStroke(livePrev.x, livePrev.y);
    }
    const strokeId = mintStrokeId();
    const rawStroke: InkStroke = {
      tool: liveTool,
      color: brush.color,
      weight: brush.weight, // 画布（视图）域像素；近似模式提交前换算回存储域
      // LR-1：笔画身份 + 落笔绝对时刻 + 输入来源（pointerdown 捕获）
      id: strokeId,
      ...(liveStartedAt > 0 ? { startedAt: liveStartedAt } : {}),
      ...(livePointerKind !== undefined ? { pointer: livePointerKind } : {}),
      points,
    };
    // LR-6：收笔即锚——重叠面积最大的带键块为锚；全不相交取最近块；
    // 无带键块（旧布局）不锚（P1 不伪造，anchoredRatio 如实降低）。
    // 近似原位模式：anchorBlocks 供给**视图域**块（当前布局），锚键两侧同键。
    const bbox = strokeBbox(rawStroke);
    let anchorKey: string | undefined;
    if (bbox !== null) {
      const blocks = anchorBlocks?.();
      anchorKey =
        blocks === undefined ? undefined : anchorKeyForStroke(bbox, blocks);
    }
    // 近似原位：锚定后整笔换算回存储域（与 inverseReproject 同式），存储域
    // 语义（撤销/墓碑/压实/上传校验）零变化
    const mapped = view
      ? view.strokeToStored(rawStroke, anchorKey)
      : { stroke: rawStroke, unanchored: false };
    // 评审 #12019 顺手项：映射走 root 兜底（锚键不在保存块表）时不写
    // anchors——否则服务端锚校验把整次上传 400 掉；anchoredRatio 如实降低
    if (anchorKey !== undefined && !mapped.unanchored) {
      anchors[strokeId] = anchorKey;
    }
    // 先整笔落到画布（视图域这一笔，与之后全量重绘同一画法），再提交
    if (paintWhole && atrament) {
      replayAnnotationStrokes(atrament, cssPerBase(), [rawStroke]);
    }
    withReason("stroke", () => store.commitAdd([mapped.stroke]));
  }

  /** 收笔：按已收真实采样提交（不补造终点；落笔快照分派，同引擎口径） */
  function commitLiveStroke(
    cause: import("@tutor/contract").QuestionProcessFinish,
  ): void {
    finishCause = cause;
    if (eraser.active) {
      // 结果里的下标属于删除前的正文：先结束这次擦除，再提交、重绘
      const erased = eraser.end();
      if (erased) {
        // 切剩的段沿用原笔画的锚点（近似原位时与原笔画按同一块映射）
        const origin = store.peekStrokes();
        for (const { stroke, source } of erased.added) {
          const anchorKey = anchorOf(origin[source]);
          if (stroke.id !== undefined && anchorKey !== undefined) {
            anchors[stroke.id] = anchorKey;
          }
        }
        withReason("erase", () =>
          store.commitErase(erased.removed, erased.added),
        );
      }
      redraw();
    } else {
      // 图形的点列由手势给出（没拖出大小为 null，不落笔）；手写是已收到的采样
      const shaped = shaper.active;
      const points = shaped ? shaper.end() : livePoints;
      if (points !== null && points.length > 0 && liveBrush) {
        commitStroke(liveBrush, points, liveOnLayer || shaped);
      }
    }
    finishCause = undefined;
    livePoints = [];
    livePrev = null;
    liveOnLayer = false;
    liveLayer?.clear();
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
      if (d.action === "commit") commitLiveStroke(d.cause);
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
    // LR-1：落笔绝对时刻（epoch ms）与输入来源（pointerType 直录，空串守卫）
    liveStartedAt = Date.now();
    livePointerKind = asPointerKind(e.pointerType);
    // 落笔快照：这一次手势按此刻的工具（含橡皮大小）分派
    const resolved = resolveGesture(tool, base);
    base = resolved.base;
    const gesture = resolved.gesture;

    if (gesture.kind === "erase") {
      // 引擎档位按 1000 纸基准定义 → 底图像素域等比换算
      liveEraseRadius = logicalToBase(baseWidth, gesture.radius);
      // 圈画有笔画数上限：局部擦除把一笔切成几段，切到上限后改为整笔擦掉
      eraser.begin(store.peekStrokes(), gesture.mode, {
        maxStrokes: ANNOTATION_MAX_STROKES,
      });
      const at = erasePointOf({ x, y });
      eraser.through([at.point], at.ring);
      return;
    }

    if (gesture.kind !== "draw") return;
    liveTool = gesture.tool;
    // 引擎档位按 1000 纸基准定义 → 底图像素域等比换算（视觉粗细同档）
    liveBrush = {
      color: gesture.brush.color,
      weight: logicalToBase(baseWidth, gesture.brush.weight),
    };
    if (gesture.shape !== "free") {
      shaper.begin({
        shape: gesture.shape,
        from: { x, y },
        brush: liveBrush,
        // 间距、最小跨度、箭翼这些按 1000 宽定义的量换到底图像素域
        unit: logicalToBase(baseWidth, 1),
        bounds: { width: baseWidth, height: baseHeight },
        // 荧光笔整笔一条路径，画的就是起止点的连线，不用加密
        sparse: liveTool === "highlighter",
      });
      return;
    }
    const p = pressureOf(e);
    liveOnLayer = isOnePathStroke({ tool: liveTool });
    if (liveOnLayer) {
      livePoints = [{ x, y, p, t: 0 }];
      showLiveStroke();
      return;
    }
    if (!atrament) return;
    atrament.color = liveBrush.color;
    atrament.weight = liveBrush.weight * cssPerBase();
    const start = baseToCss({ x, y });
    atrament.beginStroke(start.x, start.y);
    livePrev = atrament.draw(start.x, start.y, start.x, start.y, p);
    livePoints = [{ x, y, p, t: 0 }];
  }

  function onPointerMove(e: PointerEvent): void {
    // 橡皮悬停（鼠标、笔，没按下）：显示橡皮圈，让人先看清擦多大一块
    if (
      machine.activePointerId === null &&
      e.buttons === 0 &&
      e.pointerType !== "touch"
    ) {
      const hover = resolveGesture(tool, base).gesture;
      if (hover.kind === "erase") {
        const at = eventToBase(e);
        const radius = logicalToBase(baseWidth, hover.radius);
        liveLayer?.showRing(at.x, at.y, radius);
      }
    }
    if (!isSampleMove(machine, e.pointerId)) return;
    const rect = canvas?.getBoundingClientRect();
    let coalesced: PointerEvent[] = [];
    if (typeof e.getCoalescedEvents === "function") {
      coalesced = e.getCoalescedEvents();
    }
    const events = coalesced.length > 0 ? coalesced : [e];

    // 橡皮：一批采样记完再重画一次；橡皮圈跟到最后一个落点
    if (eraser.active) {
      const batch = events.map((ev) => erasePointOf(eventToBase(ev, rect)));
      eraser.through(
        batch.map((at) => at.point),
        batch.at(-1)?.ring,
      );
      return;
    }

    // 图形：只看这一批最后拖到哪儿，更新预览
    if (shaper.active) {
      const last = events.at(-1) ?? e;
      shaper.through(
        eventToBase(last, rect),
        Math.max(0, Math.round(last.timeStamp - liveStartStamp)),
      );
      return;
    }

    for (const ev of events) {
      const { x, y } = eventToBase(ev, rect);
      if (!liveBrush) continue;
      const p = pressureOf(ev);
      const t = Math.max(0, Math.round(ev.timeStamp - liveStartStamp));
      if (liveOnLayer) {
        livePoints.push({ x, y, p, t });
        continue;
      }
      if (!atrament) continue;
      const prev = livePrev ?? baseToCss({ x, y });
      const at = baseToCss({ x, y });
      const processed = atrament.draw(at.x, at.y, prev.x, prev.y, p);
      livePrev = processed;
      livePoints.push({ x, y, p, t });
    }
    // 一批采样只更新一次临时层
    if (liveOnLayer) showLiveStroke();
  }

  function finishPointer(event: PointerMachineEvent): void {
    const r = advancePointerMachine(machine, event);
    machine = r.state;
    for (const d of r.decisions) {
      if (d.action === "commit") {
        commitLiveStroke(d.cause);
        try {
          if (canvas?.hasPointerCapture?.(d.pointerId))
            canvas.releasePointerCapture(d.pointerId);
        } catch {
          /* 指针可能已由浏览器释放。 */
        }
      }
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

  /** 悬停留下的橡皮圈：指针离开画布就收起（拖动中的由收笔收起） */
  function onPointerLeave(): void {
    if (!eraser.active) liveLayer?.hideRing();
  }

  /** 触摸侧「笔写字、手指滚动」与长按防误触（见 touch-guards.ts） */
  const guards = createTouchGuards(() => {
    machine = observeStylusTouch(machine);
    applyTouchAction();
  });

  function bindInput(enabled: boolean): void {
    if (!canvas) return;
    canvas.dataset.inputEnabled = String(enabled);
    canvas.style.pointerEvents = enabled ? "auto" : "none";
    if (inputBound === enabled) return;
    inputBound = enabled;
    if (enabled) {
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("lostpointercapture", onLostPointerCapture);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("touchstart", guards.onTouchStart, {
        passive: false,
      });
      canvas.addEventListener("touchmove", guards.onTouchMove, {
        passive: false,
      });
      canvas.addEventListener("contextmenu", guards.onContextMenu);
      canvas.addEventListener("selectstart", guards.onSelectStart);
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);
      applyTouchAction();
    } else {
      finishPointer({ kind: "layoutchange" });
      onPointerLeave();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("touchstart", guards.onTouchStart);
      canvas.removeEventListener("touchmove", guards.onTouchMove);
      canvas.removeEventListener("contextmenu", guards.onContextMenu);
      canvas.removeEventListener("selectstart", guards.onSelectStart);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    canvas.dataset.inputEnabled = String(enabled);
    canvas.style.pointerEvents = enabled ? "auto" : "none";
  }

  // ---- 实现 ----

  const surface: AnnotationSurface = {
    mount(el: HTMLElement, initial?: AnnotationDoc): void {
      container = el;
      // 宿主由题面负责定位与尺寸；引擎只铺满它，不把覆盖层推入文档流。
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
      // 临时层与画布同一坐标域（底图像素），随宿主一起缩放
      liveLayer = createInkLiveLayer(el);
      liveLayer.setViewBox(baseWidth, baseHeight);
      applyTouchAction();

      if (initial) {
        withReason("load", () => adoptDoc(initial));
      }
      // 宿主零尺寸（固定底图工作台挂载时底图 img 尚未加载、宿主折叠）期间
      // atrament 的 CSS→位图换算会把整笔投出画布（÷0），初始重绘挂起，待
      // ResizeObserver 首次量得非零尺寸（img 加载撑起宿主即触发）补绘一次。
      const laidOut = () =>
        canvas !== null && canvas.offsetWidth > 0 && canvas.offsetHeight > 0;
      if (laidOut()) redraw();
      let awaitingLayout = !laidOut();

      bindInput(options.inputEnabled ?? true);

      // 布局变化（旋转/resize）：在途一笔先按已收点收笔（不混用两个坐标
      // 变换）；位图恒定无需重设——CSS 缩放由浏览器完成
      observer = new ResizeObserver(() => {
        finishPointer({ kind: "layoutchange" });
        if (awaitingLayout && laidOut()) {
          awaitingLayout = false;
          redraw();
        }
      });
      observer.observe(el);
    },

    getDoc,
    finish(): void {
      finishPointer({ kind: "layoutchange" });
    },
    setInputEnabled: bindInput,
    setInputMode(mode): void {
      machine = { ...machine, mode };
      applyTouchAction();
    },

    load(doc: AnnotationDoc): void {
      finishPointer({ kind: "layoutchange" });
      // LR-2/LR-4：墓碑与锚点随文档整组载入（load(getDoc()) 往返一致）
      withReason("load", () => adoptDoc(doc));
      redraw();
    },

    undo(): void {
      finishPointer({ kind: "layoutchange" });
      withReason("undo", () => store.undo());
      redraw();
    },
    redo(): void {
      finishPointer({ kind: "layoutchange" });
      withReason("redo", () => store.redo());
      redraw();
    },
    clear(): void {
      finishPointer({ kind: "layoutchange" });
      withReason("clear", () => store.commitClear());
      redraw();
    },

    setTool(next: InkToolConfig): void {
      tool = next;
      const resolved = resolveToolSpec(next, base);
      base = resolved.base;
      applyTouchAction();
      // 悬停时留下的橡皮圈不跟到别的工具上
      onPointerLeave();
    },

    canUndo(): boolean {
      return store.canUndo();
    },
    canRedo(): boolean {
      return store.canRedo();
    },

    onChange(
      cb: (
        doc: AnnotationDoc,
        reason: InkChangeReason,
        finish?: import("@tutor/contract").QuestionProcessFinish,
      ) => void,
    ): () => void {
      changeListeners.add(cb);
      return () => {
        changeListeners.delete(cb);
      };
    },

    destroy(): void {
      bindInput(false);
      observer?.disconnect();
      observer = null;
      changeListeners.clear();
      atrament?.destroy();
      atrament = null;
      ctx2d = null;
      liveLayer?.destroy();
      liveLayer = null;
      canvas?.remove();
      canvas = null;
      container = null;
    },
  };

  return surface;
}
