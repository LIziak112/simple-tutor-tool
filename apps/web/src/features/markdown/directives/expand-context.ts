import { createContext, useContext } from "react";

/**
 * 指令展开上报上下文（T2.10 lecture_expand 埋点）：
 * RichMarkdown 的 onDirectiveExpand 经此 context 下发到各指令组件，
 * 避免从 RichMarkdown → DirectiveHost → 指令组件逐层透传 props
 * （props 链变更会波及 T1.8 全部组件测试，context 缺省 null 零影响）。
 * 仅学生讲义阅读页提供回调；教师端预览等场景为 null（no-op）。
 */

/** 展开的指令信息（DirectiveProps 的 name + 文档顺序 index） */
export interface DirectiveExpandInfo {
  /** 指令名（注册表主名：solution/fold/hint/step…） */
  readonly name: string;
  /** 该指令在文档中的顺序编号（T1.8 DirectiveProps.index） */
  readonly index: number;
}

/** 展开回调（null=当前渲染上下文不收集展开事件） */
export const DirectiveExpandContext = createContext<
  ((info: DirectiveExpandInfo) => void) | null
>(null);

/** 取当前展开回调（无 Provider 返回 null，调用方空值保护） */
export function useDirectiveExpand():
  | ((info: DirectiveExpandInfo) => void)
  | null {
  return useContext(DirectiveExpandContext);
}
