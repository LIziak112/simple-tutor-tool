import { useDirectiveTelemetry } from "./session-context";

/**
 * 指令遥测兼容层（T2.10/T4.0b → T7.3 收编）：类型与 useDirectiveTelemetry
 * 自 session-context re-export，旧导入路径（Steps、页面层类型导入）零改动；
 * 新代码直接从 session-context 导入。裸 DirectiveTelemetryContext 已随收编
 * 移除——值形状不同的 Context 不能互为别名，其唯一使用方 RichMarkdown 已
 * 改用 DirectiveSessionProvider 的 telemetry 子命名空间。
 */

export type {
  DirectiveTelemetryAction,
  DirectiveTelemetryInfo,
} from "./session-context";
export { useDirectiveTelemetry };

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
 * 内部读会话上下文的 telemetry 子命名空间，映射为 action=open。
 * 新代码用 useDirectiveTelemetry（可报 open/close/reveal）。
 */
export function useDirectiveExpand():
  | ((info: DirectiveExpandInfo) => void)
  | null {
  const report = useDirectiveTelemetry();
  if (report === null) return null;
  return (info: DirectiveExpandInfo) => {
    report({ name: info.name, index: info.index, action: "open" });
  };
}
