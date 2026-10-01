import { createContext, useContext } from "react";

/**
 * 指令遥测上下文（T2.10 lecture_expand 埋点 → T4.0b 推广为 directive_interact）：
 * RichMarkdown 的回调经此 context 下发到各指令组件，避免从
 * RichMarkdown → DirectiveHost → 指令组件逐层透传 props
 * （props 链变更会波及 T1.8 全部组件测试，context 缺省 null 零影响）。
 *
 * 组件即传感器（方案 §4.1-6）：只报「什么指令、何时、什么动作」
 * （name + 文档全局序号 + open/close/reveal），不管事件归属哪个
 * scope/宿主——页面层决定要不要提供回调（教师端预览、导入预览为 null，
 * 组件行为零变化）以及事件进哪个队列。clientTs 由页面层入队时统一打。
 *
 * 仅学生讲义阅读页 / 答题页提示 / 结果页详解提供回调；其余场景为 no-op。
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

/** 遥测回调（null=当前渲染上下文不收集交互事件） */
export const DirectiveTelemetryContext = createContext<
  ((event: DirectiveTelemetryInfo) => void) | null
>(null);

/** 取当前遥测回调（无 Provider 返回 null，调用方空值保护） */
export function useDirectiveTelemetry():
  | ((event: DirectiveTelemetryInfo) => void)
  | null {
  return useContext(DirectiveTelemetryContext);
}

// ---------- T2.10 兼容别名（仅 open 方向） ----------

/** 展开的指令信息（DirectiveProps 的 name + 文档顺序 index；T2.10 形态） */
export interface DirectiveExpandInfo {
  /** 指令名（注册表主名：solution/fold/hint/step…） */
  readonly name: string;
  /** 该指令在文档中的顺序编号（T1.8 DirectiveProps.index） */
  readonly index: number;
}

/**
 * 取「仅展开方向」的上报回调（T2.10 兼容别名，保留旧调用方零改动）：
 * 内部读同一个 DirectiveTelemetryContext，映射为 action=open。
 * 新代码用 useDirectiveTelemetry（可报 open/close/reveal）。
 */
export function useDirectiveExpand():
  | ((info: DirectiveExpandInfo) => void)
  | null {
  const report = useContext(DirectiveTelemetryContext);
  if (report === null) return null;
  return (info: DirectiveExpandInfo) => {
    report({ name: info.name, index: info.index, action: "open" });
  };
}
