/**
 * Atrament 适配器（T2.7，页内答题区默认形态，架构 §5.4.0/§5.4.1）。
 *
 * 职责划分：
 * - 数据/历史/通知：纯数据层 InkStore（history.ts）；
 * - 绘制：atrament 库（官方"Programmatic drawing"接口 beginStroke/draw/endStroke）；
 * - 输入层：本文件完全接管指针/触摸事件（见下），不使用 atrament 内置的
 *   事件绑定——构造后立即 destroy() 解绑其监听（保留 canvas 2d context 上
 *   已配置好的画笔状态），从而能精确实现 §5.4.1 输入层全部要求；
 * - 指针生命周期策略（T6R.7）：纯状态机 pointer-machine.ts 给出决策
 *   （第二指针/取消/失焦/布局变化的处理矩阵见其测试），本文件负责把决策
 *   落到 DOM（capture/atrament 绘制/store 提交/touch-action/背景样式）。
 *
 * 输入层实现说明（决策矩阵已在 pointer-machine.test.ts jsdom 锁定；手感
 * 与系统手势须 iPad 真机按清单验证）：
 * 1. Pointer Events 统一处理笔/手指/鼠标；pointerType==='pen' 识别 Apple
 *    Pencil，pressure 读压感（0 值规整为 0.5，即"无压感"）。
 * 2. getCoalescedEvents() 高频采样逐点入墨（笔迹顺滑）；不支持时自动回退
 *    为单个 pointermove 事件，不报错。
 * 3. 输入模式（T6R.7，方案 §4.1）：auto=旧行为（见过笔后手指不落墨的
 *    自动探测，旧作答组件缺省且零变化）；pen=新草稿缺省「笔写／手指滚动」；
 *    finger=工具菜单「手指书写」切换。touch-action 与手指语义随模式切换，
 *    且只在**手势开始前**设置（pointerdown 后修改不可靠，W3C Pointer
 *    Events §8）。不以 UA 推断设备。
 * 4. "笔写字、手指滚动"的触摸侧：touchstart/touchmove 遍历 changedTouches
 *    核对 touchType（不默认 touches[0] 是笔——手掌先落、笔第二个落下的
 *    场景同样识别 stylus）；仅含 stylus 的事件 preventDefault()（阻断该
 *    触摸引发的原生滚动），手指（direct）触摸不拦截——canvas 置
 *    touch-action: pan-y，页面原生滚动。
 * 5. 指针生命周期：第二指针不接管活动笔（auto 模式「笔取代手掌」例外，
 *    丢弃手掌笔段）；pointercancel/lostpointercapture/窗口失焦/布局变化
 *    （旋转、resize、自动加高）一律按**已收到的真实采样**收笔——不补造
 *    终点、不粘笔、一笔中途不混用两个坐标变换（resize 后同一手势的后续
 *    采样丢弃，直到新的 pointerdown）。
 * 6. 防误触：CSS user-select/-webkit-touch-callout 关闭，拦截
 *    contextmenu/selectstart（防长按放大镜与菜单）；容器 touch-action
 *    manipulation 级别由 InkPad 页面负责（防双击缩放）。
 * 7. Apple Pencil 悬停：pointermove 且 buttons===0 时显示笔尖预览圈，
 *    不落墨。
 * 8. 屏幕端纸张背景（T6R.7）：可选配置 background（缺省 white=不设置任何
 *    背景样式，旧作答组件零变化）；格线/横线经 engine/paper-style 与 PNG
 *    渲染同源常量生成 CSS 背景，resize 时随宽度换算重设。
 *
 * 🧑 真机待确认点（T6R.1 清单第 3/4/8/9 项，自动化无法替代）：
 * - HTTP 与 HTTPS 分别：首次落笔（手指滚/笔写）、手掌先落与笔先落；
 * - 手指滚动页面与点选选项（pen 模式下手势不被画布吞掉）；
 * - Apple Pencil Scribble 输入框抢占（不应把字符漏画进画布）；
 * - 书写中途旋转设备（先收笔再换坐标变换的手感）；
 * - 系统手势边缘滑动触发 pointercancel（收笔不粘笔）。
 */
import type { NoteBackground } from "@tutor/contract";
import Atrament from "atrament";
import { type StrokeBounds, strokeBounds } from "./bounds.ts";
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
import { NOTE_PAPER_BG_COLOR, paperBackgroundCss } from "./paper-style.ts";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  observeStylusTouch,
  type PointerMachineEvent,
  type PointerMachineState,
  touchActionForInput,
} from "./pointer-machine.ts";
import type { InkChangeReason, ToolAwareSurface } from "./surface.ts";
import {
  INK_ERASE_RADIUS,
  type InkDoc,
  type InkInputMode,
  type InkPenColor,
  type InkPenSize,
  type InkStroke,
  type InkStrokePoint,
  type InkToolConfig,
  resolveToolSpec,
} from "./types.ts";

/** devicePixelRatio 上限 2：控制内存（长答题区 + 高分屏，§5.4.1 绘制层第 2 条） */
const MAX_DPR = 2;

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
  /**
   * 输入模式（T6R.7，方案 §4.1）：缺省 auto=旧行为（自动探测，旧作答
   * 组件零变化）；pen=笔写／手指滚动（新草稿缺省）；finger=手指书写。
   * 只影响**新落下**的指针，切换不打断在途笔画。
   */
  inputMode?: InkInputMode;
  /**
   * 纸张背景（T6R.7）：缺省 white=不设置任何背景样式（旧作答组件零变化）。
   * grid/line 经 engine/paper-style 与 PNG 渲染同源常量生成 CSS 背景。
   */
  background?: NoteBackground;
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

  /**
   * 指针生命周期状态机（T6R.7）：活动指针/输入模式/auto 模式的笔观测
   * （penOnly）都在这里——单一事实来源，决策矩阵见 pointer-machine.ts。
   * drawingPointerId/penOnly 等旧散置状态由此收敛。
   */
  let machine: PointerMachineState = createPointerMachineState(
    options.inputMode ?? "auto",
  );

  /** 当前一笔的归一化点序列与计时起点 */
  let livePoints: InkStrokePoint[] = [];
  let liveStartStamp = 0;
  let liveTool: "pen" | "highlighter" = "pen";
  let liveBrush: { color: string; weight: number } | null = null;
  /**
   * 落笔时的工具快照（复审③）：一笔生命周期内的 move 采样与收笔提交都按
   * **落笔时**的工具分派——工具条在笔未抬起时切换不影响在途笔画（避免
   * 「中途切橡皮→收笔误走橡皮分支→笔迹被静默丢弃」）。
   */
  let liveStrokeIsErase = false;
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

  /**
   * 指针事件 → 相对 canvas 的 CSS 像素坐标（用 clientX 而非 offsetX：
   *  coalesced 事件的 offsetX 在部分浏览器不可靠）。rect 可选注入（复审⑨）：
   *  同一 pointermove 的 coalesced 批共用一次 getBoundingClientRect——批内
   *  采样本属同一帧，共享 rect 与逐点取值语义一致且省去热路径重复布局查询。
   */
  function eventToCss(
    ev: { clientX: number; clientY: number },
    rect?: DOMRect | null,
  ): {
    x: number;
    y: number;
  } {
    const r = rect ?? canvas?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** 压力规整：0/undefined 视为无压感（0.5） */
  function pressureOf(ev: PointerEvent): number {
    return ev.pressure > 0 ? ev.pressure : 0.5;
  }

  /** 上次设置的 touch-action（同值整函数跳过——pointermove 高频路径不触发） */
  let lastTouchAction: "pan-y" | "none" | null = null;

  /** 按当前模式刷新 touch-action（手势开始前设置的口径，见 pointer-machine） */
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

  /** 屏幕端纸张背景（可选配置）：white/缺省不设置任何样式（旧组件零变化） */
  function applyPaperBackground(): void {
    if (!canvas) return;
    const bg = options.background;
    if (!bg || bg === "white") return;
    canvas.style.backgroundColor = NOTE_PAPER_BG_COLOR;
    canvas.style.backgroundImage = paperBackgroundCss(bg, cssWidth);
  }

  /**
   * canvas 尺寸随容器变化（DPR 上限 2）。会重置位图与 context 状态；
   * 尺寸未变时短路（复审⑧）——避免无差别重置位图（width 赋值清空内容）
   * 后再全量重绘。**返回是否重设了位图**（复审⑩）：调用方据此决定是否
   * 需要重绘；finishPointer 的收笔语义在 ResizeObserver 回调最先执行，
   * 不受短路影响。
   */
  function sizeCanvas(): boolean {
    if (!container || !canvas) return false;
    const nextW = container.clientWidth || 300;
    const nextH = container.clientHeight || options.height || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const nextCanvasW = Math.max(1, Math.round(nextW * dpr));
    const nextCanvasH = Math.max(1, Math.round(nextH * dpr));
    if (
      nextW === cssWidth &&
      nextH === cssHeight &&
      canvas.width === nextCanvasW &&
      canvas.height === nextCanvasH
    ) {
      return false;
    }
    cssWidth = nextW;
    cssHeight = nextH;
    canvas.width = nextCanvasW;
    canvas.height = nextCanvasH;
    // 背景间距随宽度换算，重设时同步（resize 由 ResizeObserver 触发本函数）
    applyPaperBackground();
    return true;
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
    // 只读视图同步重放（peekStrokes：重放期间无提交，零拷贝安全，复审⑨）
    store.peekStrokes().forEach((s, i) => {
      if (!pendingErase.has(i)) replayStroke(s);
    });
  }

  /** 丢弃当前正在书写的笔画（auto 模式手掌先落、笔随后落下的场景；活动指针已由状态机清除） */
  function abortLiveStroke(): void {
    if (livePrev && atrament) {
      atrament.endStroke(livePrev.x, livePrev.y);
    }
    livePoints = [];
    livePrev = null;
    liveStrokeIsErase = false;
    pendingErase = new Set();
    redraw(); // 抹掉手掌已画的部分
  }

  /**
   * 收笔：按**已收到的真实采样**提交（T6R.7，方案 §4.1「取消时只保存已收到
   * 的真实采样，不补造终点」）。up/cancel/lostcapture/blur/layoutchange/
   * superseded 共用本路径（触发源 cause 保留在状态机决策对象里，供矩阵测试
   * 断言）——终点一律用 atrament 已处理的上一坐标（livePrev），不使用事件
   * 自带坐标补造终点（cancel 事件的坐标可能是 (0,0) 或宿位值）。分派按
   * **落笔快照** liveStrokeIsErase（复审③）：工具条中途切换不改变在途笔画
   * 的提交归属。
   */
  function commitLiveStroke(): void {
    if (liveStrokeIsErase) {
      // 一次拖动的全部命中合并为一个历史条目（撤销=全部恢复）
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
            weight: brush.weight, // 逻辑单位（规格本身按宽度 1000 定义）
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

  // ---- 事件处理 ----

  function onPointerDown(e: PointerEvent): void {
    // 滚动模式：完全不拦截，页面原生滚动（工具门控先于状态机）
    if (tool.type === "scroll") return;

    const { x, y } = eventToCss(e);
    const inBounds = x >= 0 && y >= 0 && x <= cssWidth && y <= cssHeight;
    // 状态机决策：模式门控（手指/笔/鼠标）、第二指针不接管、auto 模式
    // 「笔取代手掌」的丢弃、越界不开始（但笔观测副作用仍生效——旧行为）
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
      // discard＝丢弃手掌笔段（防误触）；commit＝superseded 自愈收笔（在途
      // 笔按已收点提交后新指针接管，复审①）——先执行收尾决策再 start
      if (d.action === "discard") abortLiveStroke();
      if (d.action === "commit") commitLiveStroke();
      if (d.action === "start") started = true;
    }
    // auto 模式笔观测可能翻转 touch-action（手势开始前设置的口径）
    applyTouchAction();
    if (!started) return;

    try {
      canvas?.setPointerCapture(e.pointerId);
    } catch {
      // 个别浏览器在 canvas 未聚焦时可能抛错，忽略（pointerup 仍会冒泡到 canvas/document）
    }
    liveStartStamp = e.timeStamp;
    // 落笔快照（复审③）：本笔的 move 采样与收笔提交都按此刻的工具分派
    liveStrokeIsErase = tool.type === "eraser";

    if (liveStrokeIsErase) {
      pendingErase = new Set(
        eraseHit(
          store.peekStrokes(),
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
    // 悬停预览圈：Apple Pencil 悬停（buttons===0）且无活动笔时显示笔尖位置，
    // 不落墨（双条件合并，复审⑬）
    if (
      hoverDot &&
      machine.activePointerId === null &&
      e.pointerType === "pen" &&
      e.buttons === 0
    ) {
      const { x, y } = eventToCss(e);
      hoverDot.style.display = "block";
      hoverDot.style.left = `${x}px`;
      hoverDot.style.top = `${y}px`;
    }

    // 只有活动指针的移动被采样：零分配守卫（复审⑦，与状态机 pointermove
    // 决策严格等价——该事件不产生状态转移，见 pointer-machine.isSampleMove）；
    // 其余（第二指针/空闲期）一律忽略
    if (!isSampleMove(machine, e.pointerId)) return;

    // 高频采样：getCoalescedEvents 取全部中间采样点；不支持则回退单点。
    // rect 批前取一次（复审⑨）：coalesced 批属同一帧，共享坐标基准
    const rect = canvas?.getBoundingClientRect();
    let coalesced: PointerEvent[] = [];
    if (typeof e.getCoalescedEvents === "function") {
      coalesced = e.getCoalescedEvents();
    }
    const events = coalesced.length > 0 ? coalesced : [e];

    // 橡皮热路径快照（复审⑨）：只读零拷贝视图 + 逐笔包围盒每 move 只算
    // 一次，批内 coalesced 采样点共享（仅同步消费，见 InkStore.peekStrokes）
    let eraseView: readonly InkStroke[] | null = null;
    let eraseBoxes: Array<StrokeBounds | null> | null = null;
    if (liveStrokeIsErase) {
      eraseView = store.peekStrokes();
      eraseBoxes = eraseView.map((s) => strokeBounds(s));
    }

    for (const ev of events) {
      const { x, y } = eventToCss(ev, rect);
      if (eraseView && eraseBoxes) {
        const hits = eraseHit(
          eraseView,
          toLogical(cssWidth, x),
          toLogical(cssWidth, y),
          INK_ERASE_RADIUS,
          eraseBoxes,
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

  /**
   * 收尾事件公共路径：up/cancel/lostpointercapture/blur/布局变化都经状态机
   * （只有活动指针自己的事件收笔；收笔后同一手势的后续事件全部忽略），
   * 决策 commit 时按已收真实采样提交（不补造终点）。
   */
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

  /**
   * 窗口失焦：在途笔段按已收采样收笔。推演：失焦期间浏览器可能不再送达
   * pointermove/pointerup（或送 pointercancel），若保持"书写中"状态，重聚焦
   * 后同一手势的后续采样会以**新的布局/坐标基准**续写同一笔——正是方案
   * §4.1 禁止的「一笔混用两个坐标变换」；且停留态会把下一个无关手势误判
   * 为续写。按「取消时只保存已收到的真实采样」口径收笔是无损且可预期的
   * 选择（真机清单第 10 项复核）。
   */
  function onWindowBlur(): void {
    finishPointer({ kind: "blur" });
  }

  /**
   * 页面隐藏（切后台/锁屏）兜底（复审④）：与 blur 同口径（cause=blur）——
   * 部分环境 blur 不触发而 visibilitychange 触发（反之亦然），两监听并存；
   * 状态机对已收笔状态幂等（重复收笔=none），不会双提交。
   */
  function onVisibilityChange(): void {
    if (document.hidden) finishPointer({ kind: "blur" });
  }

  /**
   * "笔写字、手指滚动"的触摸侧（§5.4.1 输入层第 3 条，T6R.7 改为遍历）：
   * **遍历触点核对 touchType**，不默认 touches[0] 是笔。拦截条件＝新旧并集
   * （复审②）：changedTouches 含 stylus（笔这一触点新落下——手掌先落、笔
   * 第二个落下的场景里 changedTouches 才含笔）**或** e.touches 含 stylus
   * （笔已在屏书写、手掌后落——该触摸事件同样可能引发原生滚动/缩放破坏
   * 笔迹，须拦截）。纯 direct 触摸不拦截，配合 touch-action: pan-y 由
   * 浏览器原生滚动页面。
   * 🧑 真机复核：stylus 拦截在 HTTP/HTTPS 下行为一致（清单第 1 项）；笔先
   * 落手掌后落（清单第 14 项）。
   */
  function anyStylusTouch(
    touches: TouchList | Array<{ touchType?: string }> | undefined,
  ): boolean {
    // 防御：合成/不完整事件可能缺某一触点列表（真实 TouchEvent 恒两者皆有）
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
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      // 指针捕获丢失（元素/画布被移动、浏览器接管手势等）：按已收采样收笔
      canvas.addEventListener("lostpointercapture", onLostPointerCapture);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("selectstart", onSelectStart);
      // 窗口失焦/页面隐藏（切后台/锁屏/系统弹窗）：按已收采样收笔（两监听
      // 并存兜底，状态机幂等不双提交，见 onVisibilityChange 注释）
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);

      // 尺寸变化（旋转、自动加高、窗口缩放）：在途一笔先按已收点收笔——
      // 一笔中途不混用两个坐标变换（方案 §4.1；收笔后同一手势的后续采样
      // 丢弃直到新 pointerdown），然后重设画布并全量重绘（归一化坐标保证
      // 比例正确；尺寸未变时跳过重绘，复审⑩）。🧑 真机复核：书写中途旋转
      // （清单第 9 项）
      observer = new ResizeObserver(() => {
        finishPointer({ kind: "layoutchange" });
        if (sizeCanvas()) redraw();
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
      // **恒白底**（复审⑥定案）：这是旧手写作答通道的导出口径（教师/AI
      // 查看统一白底），不随 background 可选配置变——格线/横线背景的派生
      // 图走 render-note 渲染器（背景入图）。新草稿（T6R.9）是否复用本
      // 导出届时裁决；旧作答链行为不变的最稳口径就是固定白底。
      c.fillStyle = NOTE_PAPER_BG_COLOR;
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

    setInputMode(mode: InkInputMode): void {
      // 只影响新落下的指针（不打断在途笔画）；touch-action 随模式切换
      machine = { ...machine, mode };
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
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
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
