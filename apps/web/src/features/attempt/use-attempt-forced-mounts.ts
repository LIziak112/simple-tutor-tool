import { type RefObject, useCallback, useEffect, useState } from "react";
import { draftStore } from "@/features/persistence/draft-store";
import type { LazyMountWindow } from "./lazy-mount-window";

/** 跳题、阅读位置恢复与限时卷待传笔迹可越过视口挂载题卡。 */
export function useAttemptForcedMounts(
  attemptId: string,
  window: RefObject<LazyMountWindow | null>,
  questionIds: readonly string[],
  recoverInk: boolean,
) {
  const [forcedMountIds, setForcedMountIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const forceMountQuestion = useCallback(
    (questionId: string) => {
      setForcedMountIds((previous) => {
        if (previous.has(questionId)) return previous;
        const next = new Set(previous);
        next.add(questionId);
        return next;
      });
      // 跳过排队并钉住该题，避免跳题或恢复笔迹时再次卸载。
      window.current?.forceMount(questionId);
    },
    [window],
  );
  useEffect(() => {
    if (!recoverInk) return;
    for (const id of draftStore.peekUnsyncedInkIds(attemptId)) {
      if (questionIds.includes(id)) forceMountQuestion(id);
    }
  }, [attemptId, forceMountQuestion, questionIds, recoverInk]);
  return { forcedMountIds, forceMountQuestion };
}
