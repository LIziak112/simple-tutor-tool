import { useCallback, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { LazyMountWindow } from "./lazy-mount-window";

/** 每次作答独立调度；效果重放会重建控制器，不复用已 dispose 的实例。 */
export function useResultMountWindow(attemptId: string, enabled: boolean) {
  const [entry, setEntry] = useState<{
    attemptId: string;
    controller: LazyMountWindow;
  } | null>(null);
  const controller = entry?.attemptId === attemptId ? entry.controller : null;
  useLayoutEffect(() => {
    if (!enabled) {
      setEntry(null);
      return;
    }
    const next = new LazyMountWindow({ unload: false });
    setEntry({ attemptId, controller: next });
    return () => next.dispose();
  }, [attemptId, enabled]);
  const beforeJump = useCallback(
    (id: string) => {
      // 题号跳转和阅读恢复必须先提交真实题卡，再测量位置和转移焦点。
      flushSync(() => controller?.forceMount(id));
    },
    [controller],
  );
  return { controller, beforeJump };
}
