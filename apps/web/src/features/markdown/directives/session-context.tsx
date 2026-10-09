import { createContext, useContext, type ReactNode } from "react";

/**
 * 指令会话上下文（T7.3 / 方案 §4.2）：所有指令运行时状态的单一出口。
 *
 * 收编两个既有顶层 Context 为子命名空间（不再各设 Provider）：
 * - fill 填空作答（原 BlankAnswersContext，T2.6）：由题卡外层提供；
 *   null = 无作答状态（教师预览/讲义/结果视图），blank 渲染展示空框；
 * - telemetry 指令遥测（原 DirectiveTelemetryContext，T2.10/T4.0b）：
 *   由 RichMarkdown 内层提供；null = 不收集，调用方空值保护即静默 no-op。
 *
 * 嵌套语义：内层 Provider 继承外层两个命名空间，仅覆盖显式提供的字段；
 * 显式传 null 也视为覆盖（RichMarkdown 内层对遥测的遮蔽语义保持不变）。
 * 旧导入路径（BlankAnswersProvider、expand-context 的 hook 与类型）经兼容
 * 适配继续可用。本任务只收编既有输入与遥测，不预造 reportEvidence、
 * 提示请求或手写上传接口——后续能力在同一 Context 的子命名空间内扩展。
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

/** 会话上下文的值：填空与遥测两个子命名空间（null = 当前层未提供） */
export interface DirectiveSessionState {
  readonly fill: DirectiveFillState | null;
  readonly telemetry: ((event: DirectiveTelemetryInfo) => void) | null;
}

/** 无 Provider 时的缺省：无作答状态、不收集遥测（空框照常、交互照常） */
const EMPTY_SESSION: DirectiveSessionState = { fill: null, telemetry: null };

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
  telemetry,
  children,
}: {
  /** 填空作答状态；显式传 null 表示本层明确取消作答态 */
  fill?: DirectiveFillState | null;
  /** 遥测回调；显式传 null 表示本层明确不收集（遮蔽外层回调） */
  telemetry?: ((event: DirectiveTelemetryInfo) => void) | null;
  children: ReactNode;
}) {
  const outer = useContext(DirectiveSessionContext);
  const value: DirectiveSessionState = {
    fill: fill !== undefined ? fill : outer.fill,
    telemetry: telemetry !== undefined ? telemetry : outer.telemetry,
  };
  return (
    <DirectiveSessionContext.Provider value={value}>
      {children}
    </DirectiveSessionContext.Provider>
  );
}

/** 取完整会话状态（业务代码用下方子命名空间 hook；本 hook 供探针/诊断） */
export function useDirectiveSession(): DirectiveSessionState {
  return useContext(DirectiveSessionContext);
}

/** 取填空作答状态（无作答状态返回 null，blank 渲染展示空框） */
export function useDirectiveFill(): DirectiveFillState | null {
  return useContext(DirectiveSessionContext).fill;
}

/** 取遥测回调（无回调返回 null，调用方空值保护=静默 no-op） */
export function useDirectiveTelemetry():
  | ((event: DirectiveTelemetryInfo) => void)
  | null {
  return useContext(DirectiveSessionContext).telemetry;
}
