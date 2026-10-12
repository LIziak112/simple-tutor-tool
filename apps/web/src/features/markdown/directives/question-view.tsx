import { createContext, type ReactNode, useContext } from "react";

/**
 * 题块渲染模式（2026-10 讲练一体，教师语境）：
 * - 默认（无 Provider / placeholder=false）：::::question 照常渲染题面
 *   （题目编辑抽屉预览、练习文档等既有消费方零变化）；
 * - placeholder=true（教师讲练讲义预览）：题块渲染占位卡——题目内容编辑
 *   走题库，预览不提供编辑（防双源漂移）；source 携带渲染原文，供占位卡
 *   折叠展示题块原文（渲染管线会丢弃 [[答案]]，原文视图不丢）。
 * 学生端 markdown 永不含题块（lesson 安全投影），本模式仅教师路径触达。
 */
export interface QuestionView {
  /** 是否以占位卡渲染题块 */
  readonly placeholder: boolean;
  /** 渲染原文（占位卡按 sourceRange 切出题块原文） */
  readonly source: string;
}

const QuestionViewContext = createContext<QuestionView | null>(null);

/** 由 RichMarkdown 按 questionPlaceholder prop 提供（缺省 null = 照常渲染） */
export function QuestionViewProvider({
  value,
  children,
}: {
  value: QuestionView;
  children: ReactNode;
}) {
  return (
    <QuestionViewContext.Provider value={value}>
      {children}
    </QuestionViewContext.Provider>
  );
}

/** 读取题块渲染模式；无 Provider 时为「照常渲染」 */
export function useQuestionView(): QuestionView {
  return useContext(QuestionViewContext) ?? { placeholder: false, source: "" };
}
