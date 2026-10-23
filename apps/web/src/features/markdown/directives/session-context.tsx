import { createContext, type ReactNode, useContext } from "react";

/**
 * 指令会话上下文（T7.3 / 方案 §4.2）：所有指令运行时状态的单一出口。
 *
 * 收编既有顶层 Context 为子命名空间（不再各设 Provider）：
 * - fill 填空作答（原 BlankAnswersContext，T2.6）：由题卡外层提供；
 *   null = 无作答状态（教师预览/讲义/结果视图），blank 渲染展示空框；
 *   UA-02（§8.2）起兼容入口：BlankAnswersProvider 内部委托 slots 提供，
 *   直接以 fill= 提供的旧调用方仍有效（BlankDirective 回退消费）；
 * - slots 槽位命名空间（UA-02 / 方案 §8.2，内联输入的扩展点）：槽位身份
 *   (scopeId, slotId)，fill 是本阶段唯一接入方；cloze 的 "choice"、
 *   matching 的 "match" 由 QM-13 经契约定义后加入 SlotKind；
 * - telemetry 指令遥测（原 DirectiveTelemetryContext，T2.10/T4.0b）：
 *   由 RichMarkdown 内层提供；null = 不收集，调用方空值保护即静默 no-op。
 *
 * 嵌套语义：内层 Provider 继承外层各命名空间，仅覆盖显式提供的字段；
 * 显式传 null 也视为覆盖（RichMarkdown 内层对遥测的遮蔽语义保持不变）。
 * fill/slots 任一显式传 null 时**同时遮蔽两者**的兼容读取（§8.2：显式
 * null = 本层明确不是作答层，blank 回落展示空框）。fill 与 slots
 * 同时提供属配置冲突：消费端（BlankDirective）按 §8.2 以 slots 为准并
 * 开发诊断。旧导入路径（BlankAnswersProvider、expand-context 的 hook 与
 * 类型）经兼容适配继续可用。本任务不预造 reportEvidence、提示请求或
 * 手写上传接口——后续能力在同一 Context 的子命名空间内扩展。
 */

/** 指令交互动作：open=收起→展开、close=展开→收起、reveal=steps「显示下一步」 */
export type DirectiveTelemetryAction = "open" | "close" | "reveal";

/** 遥测事件（DirectiveProps 的 name + 文档全局指令序号 + 动作） */
export interface DirectiveTelemetryInfo {
  /** 指令名（注册表主名：solution/fold/hint/steps…） */
  readonly name: string;
  /** 文档全局指令序号（DirectiveProps.docIndex，从 1 起；见 remark-directive-host） */
  readonly index: number;
  readonly action: DirectiveTelemetryAction;
  /** 容器内步序号（从 1 起）；仅 steps 容器 action=reveal 时携带 */
  readonly step?: number;
}

/** 填空作答子命名空间的值形态（原 BlankAnswersState，字段不变） */
export interface DirectiveFillState {
  /** 按空序的当前值（第 i 空 ↔ values[i]；缺项视为空串） */
  readonly values: readonly string[];
  /** 第 index 空（0 起）内容变化 */
  readonly onChange: (index: number, value: string) => void;
  /** 只读态（结果视图等场景可禁用输入） */
  readonly disabled: boolean;
}

/**
 * 槽位控件类型（§8.2）：首版只 "text"——fill 的旧空位；cloze 的 "choice"、
 * matching 的 "match" 由 QM-13 经契约定义后加入（届时只新增槽位控件与登记
 * 表项，不改 remark 宿主）。
 */
export type SlotKind = "text";

/**
 * 槽位绑定：值 + 无副作用可替换的更新。get 返回 null 渲染展示空框；
 * 只读模式保留输入节点并阻断更新（disabled=true 仍渲染 input）。
 */
export interface SlotBinding {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}

/**
 * 槽位子命名空间的值形态（§8.2 草案接口）：scopeId 标识当前题目或材料的
 * 公开作用域（由宿主提供，不生成持久化版本）；槽位身份为 (scopeId, slotId)，
 * slotId 仅在作用域内唯一。
 */
export interface DirectiveSlotsState {
  readonly scopeId: string;
  /** 按 slotId 取当前槽位值与控件描述；返回 null 渲染展示空框 */
  readonly get: (slotId: string, slotKind: SlotKind) => SlotBinding | null;
  readonly disabled: boolean;
}

/** 会话上下文的值：填空、槽位与遥测三个子命名空间（null = 当前层未提供） */
export interface DirectiveSessionState {
  readonly fill: DirectiveFillState | null;
  readonly slots: DirectiveSlotsState | null;
  readonly telemetry: ((event: DirectiveTelemetryInfo) => void) | null;
}

/** 无 Provider 时的缺省：无作答状态、无槽位绑定、不收集遥测（空框照常、交互照常） */
const EMPTY_SESSION: DirectiveSessionState = {
  fill: null,
  slots: null,
  telemetry: null,
};

/**
 * 单一指令会话 Context。裸 Context 对象不导出——外部一律经
 * DirectiveSessionProvider 与下方 hooks 访问，不再出现第二条裸通道
 * （原 blankAnswersContext / DirectiveTelemetryContext 的镜像教训）。
 */
const DirectiveSessionContext =
  createContext<DirectiveSessionState>(EMPTY_SESSION);

/**
 * 提供指令会话状态：只传需要覆盖的命名空间，未传的继承外层。
 * 典型嵌套：题卡外层给 fill（BlankAnswersProvider 适配层）、RichMarkdown
 * 内层给 telemetry——内层不碰 fill，外层作答状态原样穿透到指令组件。
 */
export function DirectiveSessionProvider({
  fill,
  slots,
  telemetry,
  children,
}: {
  /** 填空作答状态；显式传 null 表示本层明确取消作答态 */
  fill?: DirectiveFillState | null;
  /** 槽位状态；显式传 null 表示本层明确遮蔽外层槽位（blank 回落展示空框） */
  slots?: DirectiveSlotsState | null;
  /** 遥测回调；显式传 null 表示本层明确不收集（遮蔽外层回调） */
  telemetry?: ((event: DirectiveTelemetryInfo) => void) | null;
  children: ReactNode;
}) {
  const outer = useContext(DirectiveSessionContext);
  // §8.2：任一内联作答命名空间显式传 null，须同时遮蔽旧 fill 与新 slots 的
  // 兼容读取（显式 null = 本层明确不是作答层，blank 渲染展示空框）——消费端
  // 无法区分「无 Provider」与「显式 null」，遮蔽只能在 Provider 层完成。
  const maskInlineAnswer = fill === null || slots === null;
  const value: DirectiveSessionState = {
    fill: fill !== undefined ? fill : maskInlineAnswer ? null : outer.fill,
    slots: slots !== undefined ? slots : maskInlineAnswer ? null : outer.slots,
    telemetry: telemetry !== undefined ? telemetry : outer.telemetry,
  };
  return (
    <DirectiveSessionContext.Provider value={value}>
      {children}
    </DirectiveSessionContext.Provider>
  );
}

/** 取填空作答状态（无作答状态返回 null，blank 渲染展示空框） */
export function useDirectiveFill(): DirectiveFillState | null {
  return useContext(DirectiveSessionContext).fill;
}

/** 取槽位状态（无槽位返回 null，blank 渲染展示空框或回退 fill 兼容路径） */
export function useDirectiveSlots(): DirectiveSlotsState | null {
  return useContext(DirectiveSessionContext).slots;
}

/** 取遥测回调（无回调返回 null，调用方空值保护=静默 no-op） */
export function useDirectiveTelemetry():
  | ((event: DirectiveTelemetryInfo) => void)
  | null {
  return useContext(DirectiveSessionContext).telemetry;
}

/**
 * 旧空位 slotId 派生规则（方案 §4.2/§8.2）：order 即旧数组下标（0 起），
 * slotId 由序号派生 slot-1…。槽位命名空间的唯一派生出处——analyzeSlots
 * （answering/prepare-question）与 BlankDirective 查询共用，避免两处各写
 * 一份字符串规则漂移。
 */
export function blankSlotIdOf(order: number): string {
  return `slot-${order + 1}`;
}

/** 中性槽位绑定的无副作用更新（公开底图用，永不上报） */
const NEUTRAL_SLOT_NOOP = (): void => {};

/**
 * 公开底图的中性槽位绑定（§8.2）：空值、无副作用更新、保留输入原尺寸——
 * 公开副本不能简单传 null（退回尺寸不同的展示 span），也不能继承外层真实
 * 答案。宿主（公开题面/导出底图）按 scopeId 提供覆盖层时使用。
 */
export function neutralSlotBinding(): SlotBinding {
  return { value: "", onChange: NEUTRAL_SLOT_NOOP, disabled: true };
}
