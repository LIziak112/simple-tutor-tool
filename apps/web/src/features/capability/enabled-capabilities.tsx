import type { EnabledCapabilityFlags } from "@tutor/contract";
import { createContext, type ReactNode, useContext } from "react";

/**
 * 辅助能力启用集的前端单一出口（T7.7 / 方案 §4.5）。
 *
 * 数据来源：学生端 attempt 详情 / 讲义详情响应的 enabledCapabilities（服务端
 * 按教师配置读时计算）；页面层（AttemptSession、讲义阅读页）包 Provider，
 * StepsDirective、HandwrittenControls、题卡草稿层（NoteLayer）共用。
 *
 * 回退语义（开关只影响渲染，不清数据、不改提交规则、不参与判分）：
 * - steps 关：完整展开全部步骤、隐藏「显示下一步」、不伪造 reveal 事件；
 * - ink 关：隐藏手写/草稿入口，保留最终答案输入与已有笔迹只读查看。
 *
 * 无 Provider = 全启用：教师预览页与既有测试零改动；「读取不到新字段的旧载荷
 * 按全启用处理」也落在这里（不包 Provider 即缺省）。启用集不是安全边界——
 * 泄露守卫由 studentStemMd 投影与 assertNoLeak 独立保证。
 */

/** 组件消费的启用形态（契约布尔形态的别名；归一函数 re-export 契约单一实现） */
export type EnabledCapabilities = EnabledCapabilityFlags;
export { toEnabledCapabilities } from "@tutor/contract";

/**
 * 启用集 Context。裸 Context 不导出（DirectiveSessionContext 同款纪律）：
 * 外部一律经 EnabledCapabilitiesProvider 与 useEnabledCapabilities 访问。
 */
const EnabledCapabilitiesContext = createContext<EnabledCapabilities>({
  steps: true,
  ink: true,
});

/** 提供启用集（页面层从响应数据归一后传入） */
export function EnabledCapabilitiesProvider({
  value,
  children,
}: {
  value: EnabledCapabilities;
  children: ReactNode;
}) {
  return (
    <EnabledCapabilitiesContext.Provider value={value}>
      {children}
    </EnabledCapabilitiesContext.Provider>
  );
}

/** 取辅助能力启用状态（无 Provider 全启用——教师预览/旧载荷/测试缺省） */
export function useEnabledCapabilities(): EnabledCapabilities {
  return useContext(EnabledCapabilitiesContext);
}
