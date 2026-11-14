import { MEMO_ANCHOR_NONE } from "@tutor/contract";
import type { LearningSource } from "@/features/learning-context/learning-context-store";
import { currentDevice } from "@/lib/device-identity";
/** 记录来源只从本次打开的快照构造，不再查询全局焦点。 */
export function memoSourceFields(source: LearningSource, dropped: boolean) {
  return {
    anchor: dropped ? MEMO_ANCHOR_NONE : source.anchor,
    ...(!dropped && source.context ? { context: source.context } : {}),
    ...(!dropped && source.reference ? { reference: source.reference } : {}),
    ...(!dropped && source.view ? { sourceView: source.view } : {}),
    ...(!dropped && source.expectedDisplay
      ? { sourceDisplay: source.expectedDisplay }
      : {}),
    ...(source.principal != null ? { sourcePrincipal: source.principal } : {}),
    deviceId: currentDevice().deviceId,
  };
}
