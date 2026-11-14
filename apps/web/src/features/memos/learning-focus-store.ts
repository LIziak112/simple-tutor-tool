import type { MemoAnchor } from "@tutor/contract";
import { useEffect, useSyncExternalStore } from "react";
import {
  type HostLease,
  learningContextStore,
} from "@/features/learning-context/learning-context-store";

/** 旧调用的纯适配：状态只在公共 LearningContext 仓。 */
const leases = new WeakMap<MemoAnchor, HostLease>();
export function publishLearningFocus(anchor: MemoAnchor): void {
  const lease = learningContextStore.registerHost("legacy", () => ({ anchor }));
  leases.set(anchor, lease);
  learningContextStore.explicit(lease, { anchor });
}
export function clearLearningFocus(anchor: MemoAnchor): void {
  const lease = leases.get(anchor);
  if (lease) learningContextStore.release(lease);
}
export function getLearningFocus(): MemoAnchor {
  return learningContextStore.getSnapshot().source.anchor;
}
export function useLearningFocus(): MemoAnchor {
  return useSyncExternalStore(
    learningContextStore.subscribe,
    getLearningFocus,
    getLearningFocus,
  );
}
export function usePublishLearningFocus(anchor: MemoAnchor | null): void {
  const key = anchor === null ? "" : JSON.stringify(anchor);
  useEffect(() => {
    if (!key) return;
    const value = JSON.parse(key) as MemoAnchor;
    publishLearningFocus(value);
    return () => clearLearningFocus(value);
  }, [key]);
}
export function resetLearningFocusForTest(): void {
  learningContextStore.reset();
}
