/**
 * Atrament 适配器（T2.7，页内答题区默认形态，架构 §5.4.0/§5.4.1）。
 *
 * 职责划分：
 * - 数据/历史/通知：纯数据层 InkStore（history.ts）；
 * - 绘制：atrament 库（官方"Programmatic drawing"接口 beginStroke/draw/endStroke）；
 * - 输入层：本文件完全接管指针/触摸事件（见下），不使用 atrament 内置的
 *   事件绑定——构造后立即 destroy() 解绑其监听（保留 canvas 2d context 上
 *   已配置好的画笔状态），从而能精确实现 §5.4.1 输入层全部要求：
 *
 * 输入层实现说明（无法在 jsdom 单测，须 iPad 真机按 §7.1 清单验证）：
 * 1. Pointer Events 统一处理笔/手指/鼠标；pointerType==='pen' 识别 Apple
 *    Pencil，pressure 读压感（0 值规整为 0.5，即"无压感"）。
 * 2. getCoalescedEvents() 高频采样逐点入墨（笔迹顺滑）；不支持时自动回退
 *    为单个 pointermove 事件，不报错。
 * 3. "笔写字、手指滚动"：canvas 监听 touchstart（passive:false），仅当
 *    touch.touchType==='stylus' 才 preventDefault() 进入书写（阻断该触摸的
 *    原生滚动）；手指触摸不拦截——canvas 置 touch-action: pan-y，页面原生
 *    滚动。一旦观测到笔（pointer 或 stylus 触摸）即进入 pen-only 模式，
 *    手指永远不落墨（防手掌误触）；无笔设备回退为手指/鼠标直接书写
 *    （touch-action: none），并提供"滚动模式"工具开关。
 * 4. 防误触：CSS user-select/-webkit-touch-callout 关闭，拦截
 *    contextmenu/selectstart（防长按放大镜与菜单）；容器 touch-action
 *    manipulation 级别由 InkPad 页面负责（防双击缩放）。
 * 5. Apple Pencil 悬停：pointermove 且 buttons===0 时显示笔尖预览圈，
 *    不落墨。
 */
import Atrament from "atrament";
import { canvasToPngBlob } from "./canvas-png.ts";
import { buildAtramentDoc, parseAtramentDoc } from "./doc.ts";
import { eraseHit } from "./erase.ts";
import { InkStore } from "./history.ts";
import {
  fromLogical,
  fromLogicalPoint,
  toLogical,
  toLogicalPoint,
} from "./normalize.ts";
import type { InkChangeReason, ToolAwareSurface } from "./surface.ts";
import {
  INK_ERASE_RADIUS,
  type InkDoc,
  type InkPenColor,
  type InkPenSize,
  type InkStroke,
  type InkStrokePoint,
  type InkToolConfig,
  resolveToolSpec,
} from "./types.ts";

/** devicePixelRatio 上限 2：控制内存（长答题区 + 高分屏，§5.4.1 绘制层第 2 条） */
const MAX_DPR = 2;

/** 手指滚动放行、笔书写时的 touch-action；笔直接书写时改为 none */
const TOUCH_ACTION_PAN_Y = "pan-y";
const TOUCH_ACTION_NONE = "none";

/**
 * 按逻辑坐标在 Atrament 实例上重放一笔（atrament 官方程序化绘制流程）。
 * T3.3 起导出：笔迹回放（features/ink/replay）复用同一绘制原语，不另写笔迹绘制。
 * @param cssWidth 当前容器 CSS 宽（逻辑 1000 → 实际像素的换算基准）
 */
export function replayAtramentStroke(
  atrament: Atrament,
  cssWidth: number,
  s: InkStroke,
): void {
  if (s.points.length === 0) return;
  atrament.color = s.color;
  atrament.weight = fromLogical(cssWidth, s.weight);
  const first = s.points[0];
  if (!first) return;
  const start = fromLogicalPoint(cssWidth, first.x, first.y);
  atrament.beginStroke(start.x, start.y);
  // 先画起点（与实时书写路径一致；单点即零长二次曲线，各引擎不栅格化
  // 出墨点——命令照发，像素语义与实时画布一致）
  let prev = atrament.draw(start.x, start.y, start.x, start.y, first.p);
  for (let i = 1; i < s.points.length; i++) {
    const pt = s.points[i];
    if (!pt) continue;
    const at = fromLogicalPoint(cssWidth, pt.x, pt.y);
    prev = atrament.draw(at.x, at.y, prev.x, prev.y, pt.p);
  }
  atrament.endStroke(prev.x, prev.y);
}

/**
 * 构造仅用于**程序化重放**的 Atrament 实例：构造即配置 canvas 2d 画笔状态
 * （source-over / lineCap round / lineJoin round），随即 destroy() 解绑其
 * 内部指针监听——后续只经 replayAtramentStroke / beginStroke/draw/endStroke
 * 驱动绘制，不接管任何输入。适配器挂载路径（输入层自管）、笔迹回放
 * （replay/draw）与草稿渲染器（notes/render-note）三处共用这一手法。
 */
export function createProgrammaticAtrament(
  canvas: HTMLCanvasElement,
): Atrament {
  const atrament = new Atrament(canvas);
  atrament.destroy();
  return atrament;
}

export interface AtramentSurfaceOptions {
  /** 初始高度提示（CSS 像素）。容器高度最终由外部（InkPad）控制 */
  height?: number;
}

/**
 * 引擎画布的 DOM 标识与选择器——外部驱动方（实验室注入器等）凭此定位画布，
 * 与适配器自身标记同源，避免字面量三处复述后失同步。
 */
export const INK_CANVAS_DATA_SLOT = "ink-canvas";
export const INK_CANVAS_SELECTOR = `canvas[data-slot="${INK_CANVAS_DATA_SLOT}"]`;

export function createAtramentSurface(
  options: AtramentSurfaceOptions = {},
): ToolAwareSurface {
  const store = new InkStore();

  // ---- 内部状态（mount 前不可用） ----
  let container: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let hoverDot: HTMLDivElement | null = null;
  let atrament: Atrament | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let observer: ResizeObserver | null = null;
  let cssWidth = 0; // 容器当前 CSS 宽（px）
  let cssHeight = 0;

  /** 当前工具配置（pen 的可选属性以 base 补全） */
  let tool: InkToolConfig = { type: "pen" };
  let base: { color: InkPenColor; size: InkPenSize } = {
    color: "black",
    size: "medium",
  };

  /** 见过笔之后为 true：手指不再落墨（Apple Pencil 防手掌误触） */
  let penOnly = false;

  /** 正在书写的指针 id（同时只允许一个指针落墨；null=空闲） */
  let drawingPointerId: number | null = null;
  let drawingPointerType: string = "";
  /** 当前一笔的归一化点序列与计时起点 */
  let livePoints: InkStrokePoint[] = [];
  let liveStartStamp = 0;
  let liveTool: "pen" | "highlighter" = "pen";
  let liveBrush: { color: string; weight: number } | null = null;
  /** 上一次 draw() 返回的已处理坐标（atrament 平滑过滤后的位置） */
  let livePrev: { x: number; y: number } | null = null;
  /** 橡皮拖动中待删除的笔画下标集合（一次拖动合并为一个历史条目） */
  let pendingErase = new Set<number>();

  /**
   * 下一次 store 变化通知携带的原因（T4.0b，§5.0-C14）：在调用 store 的变更
   * 方法前赋值，subscribe 回调读取后复位。store 的每次状态变化都由本适配器的
   * 一个明确操作触发（commitAdd/commitErase/commitClear/undo/redo/replace），
   * 未及赋值的旁路通知按缺省 "stroke" 处理。
   */
  let reasonOverride: InkChangeReason | null = null;
  store.subscribe(() => {
    const reason = reasonOverride ?? "stroke";
    reasonOverride = null;
    notifyListeners(reason);
  });

  /** 变更监听（surface.onChange 注册的回调集合） */
  const changeListeners = new Set<
    (doc: InkDoc, reason: InkChangeReason) => void
  >();
  function notifyListeners(reason: InkChangeReason): void {
    const doc = buildAtramentDoc(store);
    for (const cb of changeListeners) cb(doc, reason);
  }
  /** 在 reason 标记下执行一次 store 变更（§5.0-C14 分型） */
  function withReason<T>(reason: InkChangeReason, action: () => T): T {
    reasonOverride = reason;
    try {
      return action();
    } finally {
      reasonOverride = null;
    }
  }

  // ---- 工具函数 ----

  /** 指针事件 → 相对 canvas 的 CSS 像素坐标（用 clientX 而非 offsetX：
   *  coalesced 事件的 offsetX 在部分浏览器不可靠） */
  function eventToCss(ev: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /** 压力规整：0/undefined 视为无压感（0.5） */
  function pressureOf(ev: PointerEvent): number {
    return ev.pressure > 0 ? ev.pressure : 0.5;
  }

  /** 按当前模式刷新 touch-action（笔/滚动模式放行纵向滚动） */
  function applyTouchAction(): void {
    const mode =
      tool.type === "scroll" || penOnly
        ? TOUCH_ACTION_PAN_Y
        : TOUCH_ACTION_NONE;
    if (canvas) canvas.style.touchAction = mode;
    if (container) container.style.touchAction = mode;
  }

  /** canvas 尺寸随容器变化（DPR 上限 2）。会重置位图与 context 状态 */
  function sizeCanvas(): void {
    if (!container || !canvas) return;
    cssWidth = container.clientWidth || 300;
    cssHeight = container.clientHeight || options.height || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  /** 重置 2d context 画笔状态（canvas.width 赋值会清掉 lineCap 等） */
  function resetContext(): void {
    const c = ctx2d;
    if (!c) return;
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    c.lineCap = "round";
    c.lineJoin = "round";
  }

  /** 按当前容器宽度重放一笔（模块级原语的闭包便捷封装） */
  function replayStroke(s: InkStroke): void {
    if (!atrament) return;
    replayAtramentStroke(atrament, cssWidth, s);
  }

  /** 全量重绘：清位图 → 重置 context → 依次重放（跳过 pendingErase 中的笔画） */
  function redraw(): void {
    const c = ctx2d;
    if (!c || !canvas) return;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.restore();
    resetContext();
    store.getStrokes().forEach((s, i) => {
      if (!pendingErase.has(i)) replayStroke(s);
    });
  }

  /** 丢弃当前正在书写的笔画（用于手掌先落笔、笔随后落下的场景） */
  function abortLiveStroke(): void {
    if (drawingPointerId === null) return;
    if (livePrev && atrament) {
      atrament.endStroke(livePrev.x, livePrev.y);
    }
    drawingPointerId = null;
    livePoints = [];
    livePrev = null;
    pendingErase = new Set();
    redraw(); // 抹掉手掌已画的部分
  }

  // ---- 事件处理 ----

  function onPointerDown(e: PointerEvent): void {
    // 滚动模式：完全不拦截，页面原生滚动
    if (tool.type === "scroll") return;
    // pen-only 模式下手指不落墨（防手掌误触）；页面照常滚动
    if (e.pointerType === "touch" && penOnly) return;
    // 仅主键（右键等不写）
    if (e.button > 0) return;

    if (e.pointerType === "pen") {
      // 首次观测到笔 → 进入 pen-only；若手掌（touch）正落墨，丢弃那一笔
      penOnly = true;
      if (drawingPointerId !== null && drawingPointerType === "touch") {
        abortLiveStroke();
      }
      applyTouchAction();
    }

    const { x, y } = eventToCss(e);
    if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) return;

    try {
      canvas?.setPointerCapture(e.pointerId);
    } catch {
      // 个别浏览器在 canvas 未聚焦时可能抛错，忽略（pointerup 仍会冒泡到 canvas/document）
    }
    drawingPointerId = e.pointerId;
    drawingPointerType = e.pointerType;
    liveStartStamp = e.timeStamp;

    if (tool.type === "eraser") {
      pendingErase = new Set(
        eraseHit(
          store.getStrokes(),
          toLogical(cssWidth, x),
          toLogical(cssWidth, y),
          INK_ERASE_RADIUS,
        ),
      );
      redraw();
      return;
    }

    const resolved = resolveToolSpec(tool, base);
    liveBrush = resolved.brush;
    base = resolved.base;
    liveTool = tool.type === "highlighter" ? "highlighter" : "pen";
    if (!liveBrush || !atrament) return;
    atrament.color = liveBrush.color;
    atrament.weight = fromLogical(cssWidth, liveBrush.weight);
    atrament.beginStroke(x, y);
    // 起点先画一个墨点（轻点可见），并记录归一化点
    const p = pressureOf(e);
    livePrev = atrament.draw(x, y, x, y, p);
    livePoints = [{ ...toLogicalPoint(cssWidth, x, y), p, t: 0 }];
  }

  function onPointerMove(e: PointerEvent): void {
    // 悬停预览圈：Apple Pencil 悬停（buttons===0）显示笔尖位置，不落墨
    if (hoverDot && drawingPointerId === null) {
      if (e.pointerType === "pen" && e.buttons === 0) {
        const { x, y } = eventToCss(e);
        hoverDot.style.display = "block";
        hoverDot.style.left = `${x}px`;
        hoverDot.style.top = `${y}px`;
      }
    }

    if (drawingPointerId === null || e.pointerId !== drawingPointerId) return;

    // 高频采样：getCoalescedEvents 取全部中间采样点；不支持则回退单点
    let coalesced: PointerEvent[] = [];
    if (typeof e.getCoalescedEvents === "function") {
      coalesced = e.getCoalescedEvents();
    }
    const events = coalesced.length > 0 ? coalesced : [e];

    for (const ev of events) {
      const { x, y } = eventToCss(ev);
      if (tool.type === "eraser") {
        const hits = eraseHit(
          store.getStrokes(),
          toLogical(cssWidth, x),
          toLogical(cssWidth, y),
          INK_ERASE_RADIUS,
        );
        let changed = false;
        for (const h of hits) {
          if (!pendingErase.has(h)) {
            pendingErase.add(h);
            changed = true;
          }
        }
        if (changed) redraw(); // 即时反馈：命中的笔画从视图中消失（提交在收笔时）
        continue;
      }
      if (!atrament || !liveBrush) continue;
      const p = pressureOf(ev);
      const prev = livePrev ?? { x, y };
      const processed = atrament.draw(x, y, prev.x, prev.y, p);
      livePrev = processed;
      livePoints.push({
        ...toLogicalPoint(cssWidth, x, y),
        p,
        t: Math.max(0, Math.round(ev.timeStamp - liveStartStamp)),
      });
    }
  }

  function onPointerFinish(e: PointerEvent): void {
    if (drawingPointerId === null || e.pointerId !== drawingPointerId) return;
    const { x, y } = eventToCss(e);

    if (tool.type === "eraser") {
      // 一次拖动的全部命中合并为一个历史条目（撤销=全部恢复）
      if (pendingErase.size > 0) {
        withReason("erase", () => store.commitErase([...pendingErase]));
      }
      pendingErase = new Set();
      redraw();
    } else if (livePoints.length > 0 && liveBrush) {
      if (atrament) {
        const last = livePrev ?? { x, y };
        atrament.endStroke(last.x, last.y);
      }
      const brush = liveBrush;
      const points = livePoints;
      withReason("stroke", () =>
        store.commitAdd([
          {
            tool: liveTool,
            color: brush.color,
            weight: brush.weight, // 逻辑单位（规格本身按宽度 1000 定义）
            points,
          },
        ]),
      );
    }
    drawingPointerId = null;
    drawingPointerType = "";
    livePoints = [];
    livePrev = null;
  }

  /**
   * "笔写字、手指滚动"的触摸侧（§5.4.1 输入层第 3 条）：
   * 仅笔（stylus）触摸被 preventDefault——阻断该触摸引发的原生滚动，让随后的
   * pointer 事件完整送达本层书写；手指（direct）触摸不拦截，配合
   * touch-action: pan-y 由浏览器原生滚动页面。
   */
  function onTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    if (t && t.touchType === "stylus") {
      penOnly = true;
      applyTouchAction();
      e.preventDefault();
    }
  }

  function onTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (t && t.touchType === "stylus") e.preventDefault();
  }

  function onContextMenu(e: Event): void {
    e.preventDefault(); // 防长按弹出系统菜单/放大镜
  }

  function onSelectStart(e: Event): void {
    e.preventDefault(); // 防长按选择文字
  }

  function onPointerLeave(): void {
    if (hoverDot) hoverDot.style.display = "none";
  }

  // ---- InkSurface 实现 ----

  const surface: ToolAwareSurface = {
    mount(el: HTMLElement, initial?: InkDoc): void {
      container = el;
      // 防误触与布局（§5.4.1 输入层第 4 条）。
      // -webkit-* 前缀属性不在标准 CSSStyleDeclaration 类型里，用 setProperty 设置
      el.style.position = "relative";
      el.style.overflow = "hidden";
      el.style.userSelect = "none";
      el.style.setProperty("-webkit-user-select", "none");
      el.style.setProperty("-webkit-touch-callout", "none");

      canvas = document.createElement("canvas");
      canvas.setAttribute("data-slot", INK_CANVAS_DATA_SLOT);
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      canvas.style.cursor = "crosshair";

      hoverDot = document.createElement("div");
      hoverDot.setAttribute("data-slot", "ink-hover");
      hoverDot.style.position = "absolute";
      hoverDot.style.width = "20px";
      hoverDot.style.height = "20px";
      hoverDot.style.borderRadius = "9999px";
      hoverDot.style.border = "1.5px solid rgba(31, 35, 40, 0.45)";
      hoverDot.style.background = "rgba(31, 35, 40, 0.06)";
      hoverDot.style.transform = "translate(-50%, -50%)";
      hoverDot.style.pointerEvents = "none";
      hoverDot.style.display = "none";

      el.appendChild(canvas);
      el.appendChild(hoverDot);

      sizeCanvas();
      ctx2d = canvas.getContext("2d");
      if (!ctx2d)
        throw new Error("无法创建 canvas 2d 上下文（当前环境不支持）");
      // 构造 atrament（配置好 2d context 画笔状态）后立刻解绑其内部指针
      // 监听：输入层完全由本文件接管（见文件头与 createProgrammaticAtrament）
      atrament = createProgrammaticAtrament(canvas);

      applyTouchAction();

      if (initial) {
        withReason("load", () =>
          store.replace(parseAtramentDoc(initial), initial.updatedAt),
        );
      }
      redraw();

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerFinish);
      canvas.addEventListener("pointercancel", onPointerFinish);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("selectstart", onSelectStart);

      // 尺寸变化（旋转、自动加高、窗口缩放）：重设画布并全量重绘（归一化坐标保证比例正确）
      observer = new ResizeObserver(() => {
        sizeCanvas();
        redraw();
      });
      observer.observe(el);
    },

    getDoc(): InkDoc<"atrament"> {
      return buildAtramentDoc(store);
    },

    load(data: InkDoc): void {
      withReason("load", () =>
        store.replace(parseAtramentDoc(data), data.updatedAt),
      );
      redraw();
    },

    async exportPng(): Promise<Blob> {
      if (!canvas) throw new Error("导出失败：画布尚未挂载");
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const c = out.getContext("2d");
      if (!c) throw new Error("导出失败：无法创建画布上下文");
      c.fillStyle = "#ffffff"; // 白底（老师/AI 查看统一白底）
      c.fillRect(0, 0, out.width, out.height);
      c.drawImage(canvas, 0, 0);
      return canvasToPngBlob(out);
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

    onChange(cb: (doc: InkDoc, reason: InkChangeReason) => void): () => void {
      changeListeners.add(cb);
      return () => {
        changeListeners.delete(cb);
      };
    },

    destroy(): void {
      observer?.disconnect();
      observer = null;
      changeListeners.clear();
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerFinish);
        canvas.removeEventListener("pointercancel", onPointerFinish);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("touchstart", onTouchStart);
        canvas.removeEventListener("touchmove", onTouchMove);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("selectstart", onSelectStart);
      }
      atrament?.destroy();
      atrament = null;
      ctx2d = null;
      hoverDot?.remove();
      hoverDot = null;
      canvas?.remove();
      canvas = null;
      container = null;
    },
  };

  return surface;
}
