import type { ReactNode } from "react";

import {
  type DirectiveFillState,
  DirectiveSessionProvider,
} from "./directives/session-context";

/**
 * 填空作答上下文（T2.6）——T7.3 起为 DirectiveSessionContext fill 子命名空间
 * 的兼容适配层：BlankAnswersProvider 委托 DirectiveSessionProvider 提供 fill，
 * 题卡等旧调用方零改动；类型经别名 re-export。裸 blankAnswersContext 已随
 * 收编移除（值形状不同的 Context 不能互为别名），其唯一消费方 BlankDirective
 * 已改用 useDirectiveFill。
 *
 * 设计（T2.6 语义不变）：答题页用 <BlankAnswersProvider> 包住 <RichMarkdown>，
 * 题干中的 [[…]] 空框从纯展示变为可输入控件——填空题学生在题干原位作答；
 * 未提供 fill 子命名空间的场景（教师预览、讲义、结果视图）渲染展示空框。
 */

/** 填空作答状态（由答题页持有并防抖保存；形态与收编前完全一致） */
export type BlankAnswersState = DirectiveFillState;

/** 提供填空作答状态（答题页填空题专用；其余场景不包即纯展示） */
export function BlankAnswersProvider({
  state,
  children,
}: {
  state: BlankAnswersState;
  children: ReactNode;
}) {
  return (
    <DirectiveSessionProvider fill={state}>{children}</DirectiveSessionProvider>
  );
}
