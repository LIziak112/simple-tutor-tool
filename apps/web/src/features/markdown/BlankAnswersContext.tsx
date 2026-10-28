import type { ReactNode } from "react";

import {
  type DirectiveFillState,
  DirectiveSessionProvider,
  type DirectiveSlotsState,
  type SlotBinding,
} from "./directives/session-context";

/**
 * 填空作答上下文（T2.6）——T7.3 起为 DirectiveSessionContext fill 子命名空间
 * 的兼容适配层；UA-02（§8.2）起内部委托 slots 子命名空间：BlankAnswersProvider
 * 把按空序的 fill 状态换算为 (scopeId, slotId) 槽位绑定向下提供，**不再同时
 * 提供 fill**（避免与 slots 双供的冲突诊断；BlankDirective 以 slots 优先消费）。
 * 直接以 DirectiveSessionProvider fill= 提供的旧调用方不受影响（回退路径）。
 * 题卡等旧调用方零改动；未提供 fill/slots 的场景（教师预览、讲义、结果视图）
 * 渲染展示空框。
 *
 * 设计（T2.6 语义不变）：答题页用 <BlankAnswersProvider> 包住 <RichMarkdown>，
 * 题干中的 [[…]] 空框从纯展示变为可输入控件——填空题学生在题干原位作答。
 */

/** 填空作答状态（由答题页持有并防抖保存；形态与收编前完全一致） */
export type BlankAnswersState = DirectiveFillState;

/** slotId（slot-N，N 从 1 起）→ 旧空序下标（N-1）；非约定 slotId 不受理（返回 null 渲染展示空框） */
function orderOfSlotId(slotId: string): number | null {
  const match = /^slot-(\d+)$/u.exec(slotId);
  return match === null ? null : Number(match[1]) - 1;
}

/** fill 状态 → slots 子命名空间（§8.2 兼容委托；空序下标即槽位 order） */
function slotsFromFill(
  state: DirectiveFillState,
  scopeId: string,
): DirectiveSlotsState {
  return {
    scopeId,
    disabled: state.disabled,
    get: (slotId, slotKind): SlotBinding | null => {
      if (slotKind !== "text") return null;
      const order = orderOfSlotId(slotId);
      if (order === null) return null;
      return {
        value: state.values[order] ?? "",
        onChange: (value) => state.onChange(order, value),
        disabled: state.disabled,
      };
    },
  };
}

/**
 * 提供填空作答状态（答题页填空题专用；其余场景不包即纯展示）。
 * scopeId 可选：旧调用方未提供时用固定兼容作用域（槽位隔离由各 Provider
 * 实例保证——就近 Provider 优先，嵌套公开副本经 slots 覆盖层遮蔽）。
 */
export function BlankAnswersProvider({
  state,
  scopeId = "fill",
  children,
}: {
  state: BlankAnswersState;
  /** 题面实例标识（宿主可提供以便诊断与未来材料作用域；不持久化） */
  scopeId?: string;
  children: ReactNode;
}) {
  return (
    <DirectiveSessionProvider slots={slotsFromFill(state, scopeId)}>
      {children}
    </DirectiveSessionProvider>
  );
}
