import { createContext, type ReactNode } from "react";

/**
 * 填空作答上下文（T2.6 答题页）：提供后，题干中的 [[…]] 空框（blank 指令）
 * 从纯展示变为可输入控件——填空题学生在题干原位作答，无需另设答案区。
 *
 * 设计：答题页用 <BlankAnswersProvider> 包住 <RichMarkdown>，BlankDirective
 * 按自身编号（remark-directive-host 的 blank 计数）读写 values[i]；
 * 未提供上下文的场景（教师预览、讲义、结果视图）渲染不变的展示空框。
 */

/** 填空作答状态（由答题页持有并防抖保存） */
export interface BlankAnswersState {
  /** 按空序的当前值（第 i 空 ↔ values[i]；缺项视为空串） */
  readonly values: readonly string[];
  /** 第 index 空（0 起）内容变化 */
  readonly onChange: (index: number, value: string) => void;
  /** 只读态（结果视图等场景可禁用输入） */
  readonly disabled: boolean;
}

const BlankAnswersContext = createContext<BlankAnswersState | null>(null);

export const blankAnswersContext = BlankAnswersContext;

/** 提供填空作答状态（答题页填空题专用；其余场景不包即纯展示） */
export function BlankAnswersProvider({
  state,
  children,
}: {
  state: BlankAnswersState;
  children: ReactNode;
}) {
  return (
    <BlankAnswersContext.Provider value={state}>
      {children}
    </BlankAnswersContext.Provider>
  );
}
