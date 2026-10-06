/**
 * 指针生命周期状态机（T6R.7，方案 §4.1「输入状态机显式处理……」的纯数据层）。
 *
 * 职责：对每类输入事件给出唯一决策（开始/采样/收笔/丢弃/忽略），并维护
 * 「当前活动指针」。坐标换算、atrament 绘制、touch-action 的 DOM 落地都在
 * 适配器（atrament-adapter.ts）——本文件不碰 DOM，可完整单测。
 *
 * 状态机语义（与方案 §4.1 逐条对应）：
 * - 只接受当前活动指针：第二指针永不接管（唯一例外＝auto 模式笔取代手掌
 *   先落的笔段，属既有防误触语义，discard 后 start）；
 * - pointercancel / lostpointercapture / 窗口失焦 / 布局变化：按**已收到的
 *   真实采样**收笔（cause 区分触发源），不补造终点、不粘笔——收笔后同一
 *   物理手势的后续事件一律忽略，直到新的 pointerdown；
 * - 布局变化（旋转/resize）在途一笔先收笔、再由适配器建立新坐标变换：
 *   一笔中途绝不混用两个坐标变换；
 * - 模式（InkInputMode）只影响**新落下**的指针：auto=旧自动探测（penObserved
 *   见过笔后手指不落墨）、pen=手指恒滚动、finger=手指直接书写；鼠标任何
 *   模式恒可写；不以 UA 推断。
 *
 * 决策为何包含 cause：适配器对 up/cancel/lostcapture/blur/layoutchange 的
 * 执行体相同（commit 已收采样），但 cause 保留在决策里供日志/测试断言——
 * 事件→行为矩阵的可审计口径。
 */
import type { InkInputMode } from "./types.ts";

/** 指针设备类型（PointerEvent.pointerType 的透传：pen/touch/mouse/未来值） */
export type PointerDeviceType = string;

/** 收笔触发源：up=正常抬笔；cancel/lostcapture/blur/layoutchange=外部打断 */
export type PointerFinishCause =
  | "up"
  | "cancel"
  | "lostpointercapture"
  | "blur"
  | "layoutchange";

/** 输入事件（适配器把 DOM 事件折算成这里的纯数据） */
export type PointerMachineEvent =
  | {
      kind: "pointerdown";
      pointerId: number;
      pointerType: PointerDeviceType;
      /** 主键=0；右键等 >0 不写 */
      button: number;
      /** 是否落在画布边界内（越界不开始，但 auto 模式的笔观测副作用仍生效） */
      inBounds: boolean;
    }
  | { kind: "pointermove"; pointerId: number }
  | { kind: "pointerup"; pointerId: number }
  | { kind: "pointercancel"; pointerId: number }
  | { kind: "lostpointercapture"; pointerId: number }
  | { kind: "blur" }
  | { kind: "layoutchange" };

/** 状态机决策（一次事件可能产生多条，如「丢弃手掌笔段 + 笔开始」） */
export type PointerDecision =
  | { action: "none" }
  /** 丢弃活动笔段（auto 模式手掌先落、笔随后的防误触；适配器抹掉已画部分） */
  | { action: "discard" }
  /** 开始跟踪该指针（适配器：capture + beginStroke/开始橡皮） */
  | { action: "start"; pointerId: number }
  /** 采样一个点（适配器：coalesced 批量入墨/橡皮命中） */
  | { action: "sample"; pointerId: number }
  /** 按**已收到的真实采样**收笔（不补造终点）；适配器据此 commit */
  | { action: "commit"; pointerId: number; cause: PointerFinishCause };

/** 状态机状态（不可变；advance 返回新状态） */
export interface PointerMachineState {
  mode: InkInputMode;
  /** auto 模式下观测到过笔（penOnly）；pen 模式语义上恒为 true、finger 恒为 false（本字段不使用） */
  penObserved: boolean;
  /** 正在书写的指针 id；null=空闲。同时只允许一个活动指针 */
  activePointerId: number | null;
  activePointerType: PointerDeviceType | null;
}

/** 初始状态 */
export function createPointerMachineState(
  mode: InkInputMode,
): PointerMachineState {
  return {
    mode,
    penObserved: false,
    activePointerId: null,
    activePointerType: null,
  };
}

/** advance 的返回：新状态 + 依序执行的决策列表 */
export interface PointerMachineResult {
  state: PointerMachineState;
  decisions: PointerDecision[];
}

function none(state: PointerMachineState): PointerMachineResult {
  return { state, decisions: [{ action: "none" }] };
}

function finishActive(
  state: PointerMachineState,
  cause: PointerFinishCause,
): PointerMachineResult {
  const pointerId = state.activePointerId;
  if (pointerId === null) return none(state);
  return {
    state: { ...state, activePointerId: null, activePointerType: null },
    decisions: [{ action: "commit", pointerId, cause }],
  };
}

function onPointerDown(
  state: PointerMachineState,
  ev: Extract<PointerMachineEvent, { kind: "pointerdown" }>,
): PointerMachineResult {
  // 仅主键（右键等不写）——先于一切观测副作用（与既有适配器顺序一致）
  if (ev.button > 0) return none(state);

  const isPen = ev.pointerType === "pen";
  const isTouch = ev.pointerType === "touch";

  // auto 模式：任何途径观测到笔即进入 pen-only（含越界笔——与旧行为一致）
  let next = state;
  if (isPen && state.mode === "auto" && !state.penObserved) {
    next = { ...state, penObserved: true };
  }

  // 手指是否可落墨：auto=未见笔时可（旧自动探测）；pen=恒不可（手指=滚动）；finger=恒可
  const touchAccepted =
    state.mode === "auto" ? !next.penObserved : state.mode === "finger";
  if (isTouch && !touchAccepted) return none(next);

  const decisions: PointerDecision[] = [];
  if (state.activePointerId !== null) {
    if (ev.pointerId === state.activePointerId) {
      // 异常序列：活动指针重复 pointerdown（正常 DOM 序列不会发生）——
      // 视为延续，不重入、不产生第二个 start
      return none(next);
    }
    // 第二指针：唯一允许的接管场景 = auto 模式笔取代手掌先落的笔段（防误触）
    const replacingPalm =
      state.mode === "auto" && isPen && state.activePointerType === "touch";
    if (!replacingPalm) {
      // 显式忽略：不接管活动指针（方案 §4.1「只接受当前活动指针」）
      return none(next);
    }
    decisions.push({ action: "discard" });
    next = { ...next, activePointerId: null, activePointerType: null };
  }

  // 越界：不开始（penObserved / 手掌丢弃的副作用已生效，与旧行为一致）
  if (!ev.inBounds) {
    return { state: next, decisions };
  }

  decisions.push({ action: "start", pointerId: ev.pointerId });
  return {
    state: {
      ...next,
      activePointerId: ev.pointerId,
      activePointerType: ev.pointerType,
    },
    decisions,
  };
}

/**
 * 推进状态机：输入一个事件，返回新状态与依序决策。
 * 纯函数——同一 (state, event) 恒得同一结果，事件矩阵见 pointer-machine.test.ts。
 */
export function advancePointerMachine(
  state: PointerMachineState,
  event: PointerMachineEvent,
): PointerMachineResult {
  switch (event.kind) {
    case "pointerdown":
      return onPointerDown(state, event);
    case "pointermove":
      return state.activePointerId === event.pointerId
        ? {
            state,
            decisions: [{ action: "sample", pointerId: event.pointerId }],
          }
        : none(state);
    case "pointerup":
    case "pointercancel":
    case "lostpointercapture":
      // 非活动指针的收尾事件：忽略（不粘笔；正常序列里 up 之后补发的
      // lostpointercapture 也落在这里——不双收）
      if (state.activePointerId !== event.pointerId) return none(state);
      return finishActive(
        state,
        event.kind === "pointerup"
          ? "up"
          : event.kind === "pointercancel"
            ? "cancel"
            : "lostpointercapture",
      );
    case "blur":
    case "layoutchange":
      // 窗口失焦 / 布局变化（旋转、resize、自动加高）：在途一笔按已收采样
      // 收笔（不混坐标变换、不依赖未必送达的 pointerup），空闲时无操作
      return finishActive(state, event.kind);
  }
}

/**
 * 触摸侧观测到 stylus（touchstart 的 changedTouches 含 touchType==='stylus'）：
 * auto 模式置 penObserved（与指针侧 onPointerDown 的笔观测同一状态）。
 * pen/finger 模式无状态变化（模式已决定手指语义）。
 */
export function observeStylusTouch(
  state: PointerMachineState,
): PointerMachineState {
  if (state.mode === "auto" && !state.penObserved) {
    return { ...state, penObserved: true };
  }
  return state;
}

/**
 * pointermove 的**零分配守卫**（复审⑦，适配器热路径专用）：与
 * advancePointerMachine(state, { kind: "pointermove", pointerId }) 的决策
 * 严格等价——sample ⇔ activePointerId === pointerId，且该事件的两个分支
 * 都不产生状态转移（返回原 state 对象）。守卫命中才走完整采样路径；
 * 决策矩阵测试（advance 路径）不受影响，等价性由本注释与矩阵共同锁定。
 */
export function isSampleMove(
  state: PointerMachineState,
  pointerId: number,
): boolean {
  return state.activePointerId === pointerId;
}

/**
 * touch-action 策略（必须在手势开始前正确——pointerdown 之后修改不可靠，
 * W3C Pointer Events §8；适配器只在挂载/工具/模式/观测变化时设置）：
 * - scroll 工具：恒 pan-y（放行页面滚动，不书写）；
 * - auto：未见笔 none（手指直接书写）→ 见过笔 pan-y（旧语义）；
 * - pen：手指恒滚动 pan-y；
 * - finger：手指书写 none。
 */
export function touchActionForInput(
  mode: InkInputMode,
  penObserved: boolean,
  scrollToolActive: boolean,
): "pan-y" | "none" {
  if (scrollToolActive) return "pan-y";
  switch (mode) {
    case "pen":
      return "pan-y";
    case "finger":
      return "none";
    case "auto":
      return penObserved ? "pan-y" : "none";
  }
}
