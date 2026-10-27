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

import {
  ANNOTATION_MAX_DELETED_POINTS,
  ANNOTATION_MAX_DELETED_STROKES,
  type AnnotationDoc,
  type AnnotationSurfaceCompatibility,
} from "@tutor/contract";
import type Atrament from "atrament";
import {
  anchorKeyForStroke,
  strokeBbox,
} from "@/features/annotation/annotation-anchor";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter.ts";
import {
  type StrokeBounds,
  strokeBounds,
} from "@/features/ink/engine/bounds.ts";
import { eraseHit } from "@/features/ink/engine/erase.ts";
import { InkStore, mintStrokeId } from "@/features/ink/engine/history.ts";
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
  asPointerKind,
  INK_ERASE_RADIUS,
  INK_LOGICAL_WIDTH,
  type InkInputMode,
  type InkPointerKind,
  type InkStroke,
  type InkStrokePoint,
  type InkToolConfig,
  resolveToolSpec,
} from "@/features/ink/engine/types.ts";

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
  let observer: ResizeObserver | null = null;
  let inputBound = false;

  let tool: InkToolConfig = { type: "pen" };
  let base: {
    color: "black" | "blue" | "red";
    size: "thin" | "medium" | "thick";
  } = {
    color: "red",
    size: "medium",
  };

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
  let liveStrokeIsErase = false;
  let livePrev: { x: number; y: number } | null = null;
  let pendingErase = new Set<number>();
  let erasePrev: Pick<InkStrokePoint, "x" | "y"> | undefined;

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
      // 近似原位：文档恒在存储域（保存底图域），画布域（视图）只是显示
      baseWidth: view?.storedBaseWidth ?? baseWidth,
      baseHeight: view?.storedBaseHeight ?? baseHeight,
      strokes: store.getStrokes(),
      // LR-2/LR-4：墓碑与锚点非空才写键（空稿/旧稿字节兼容）
      ...(store.getDeleted().length > 0 ? { deleted: store.getDeleted() } : {}),
      ...(Object.keys(anchors).length > 0 ? { anchors: { ...anchors } } : {}),
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
      if (pendingErase.has(i)) return;
      // 近似原位：重绘在视图域画——存储笔画经锚映射到当前布局（锚缺失走 root）
      replayAnnotationStroke(
        a,
        scale,
        view
          ? view.strokeToView(s, s.id === undefined ? undefined : anchors[s.id])
          : s,
      );
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
    erasePrev = undefined;
    redraw();
  }

  /** 收笔：按已收真实采样提交（不补造终点；落笔快照分派，同引擎口径） */
  function commitLiveStroke(): void {
    if (liveStrokeIsErase) {
      // 删除前的预览下标不能继续用于删除后正文。
      const indices = [...pendingErase];
      pendingErase.clear();
      if (indices.length > 0) {
        withReason("erase", () => store.commitErase(indices));
      }
      redraw();
    } else if (livePoints.length > 0 && liveBrush) {
      if (atrament && livePrev) {
        atrament.endStroke(livePrev.x, livePrev.y);
      }
      const brush = liveBrush;
      const points = livePoints;
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
      withReason("stroke", () => store.commitAdd([mapped.stroke]));
    }
    livePoints = [];
    livePrev = null;
    liveStrokeIsErase = false;
    pendingErase = new Set();
    erasePrev = undefined;
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
    // LR-1：落笔绝对时刻（epoch ms）与输入来源（pointerType 直录，空串守卫）
    liveStartedAt = Date.now();
    livePointerKind = asPointerKind(e.pointerType);
    liveStrokeIsErase = tool.type === "eraser";

    if (liveStrokeIsErase) {
      // 近似原位：橡皮命中在存储域做——指针点先映射回存储域（ratio 供半径换算）
      const stored = view ? view.pointToStored({ x, y }) : { x, y, ratio: 1 };
      erasePrev = { x: stored.x, y: stored.y };
      pendingErase = new Set(
        eraseHit(
          store.peekStrokes(),
          stored.x,
          stored.y,
          logicalToBase(baseWidth, INK_ERASE_RADIUS) * stored.ratio,
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
        // 近似原位：逐采样映射回存储域再整笔命中（半径按局部线比换算）
        const stored = view ? view.pointToStored({ x, y }) : { x, y, ratio: 1 };
        const hits = eraseHit(
          eraseView,
          stored.x,
          stored.y,
          radius * stored.ratio,
          eraseBoxes,
          erasePrev,
        );
        erasePrev = { x: stored.x, y: stored.y };
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
      if (d.action === "commit") {
        commitLiveStroke();
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
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("selectstart", onSelectStart);
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);
      applyTouchAction();
    } else {
      finishPointer({ kind: "layoutchange" });
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("selectstart", onSelectStart);
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
      bindInput(false);
      observer?.disconnect();
      observer = null;
      changeListeners.clear();
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
