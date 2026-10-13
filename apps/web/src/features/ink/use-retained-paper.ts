import { useEffect, useState } from "react";

export const PAPER_KEEPALIVE_MS = 45_000;

/** 收起时先收笔并确认本机落盘；短期保活，失败继续保留引擎。 */
export function useRetainedPaper(
  active: boolean,
  finish: () => Promise<void>,
): boolean {
  const [retained, setRetained] = useState(active);
  useEffect(() => {
    if (active) {
      setRetained(true);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void finish().then(
        () => {
          if (!cancelled) setRetained(false);
        },
        () => undefined,
      );
    }, PAPER_KEEPALIVE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, finish]);
  return active || retained;
}
