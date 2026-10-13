import { type RefObject, useCallback, useEffect, useRef } from "react";

/** 草稿展开前后保护当前题位置；用户先行操作时取消迟到定位。 */
export function usePaperPosition(ref: RefObject<HTMLElement | null>) {
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), []);
  return useCallback(
    async (request: () => Promise<boolean>, protect = true) => {
      pending.current?.();
      if (!protect) return request();
      const element = ref.current;
      if (!element) return request();
      const before = element.getBoundingClientRect().top;
      let cancelled = false;
      let frame = 0;
      const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
      const cancel = () => {
        cancelled = true;
        cancelAnimationFrame(frame);
        for (const event of events)
          window.removeEventListener(event, cancel, true);
        if (pending.current === cancel) pending.current = null;
      };
      pending.current = cancel;
      for (const event of events)
        window.addEventListener(event, cancel, {
          capture: true,
          passive: true,
        });
      try {
        const opened = await request();
        if (!opened || cancelled) {
          cancel();
          return opened;
        }
        // 等 React 提交与分栏宽度观察完成，使用最终几何判断，避免每次展开都滚动。
        frame = requestAnimationFrame(() => {
          if (cancelled) return;
          frame = requestAnimationFrame(() => {
            if (cancelled) return;
            const after = element.getBoundingClientRect().top;
            const margin =
              Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
            const moved = Math.abs(after - before) > 1;
            if (
              element.isConnected &&
              moved &&
              (after < margin || after >= window.innerHeight)
            )
              element.scrollIntoView({ block: "start", behavior: "instant" });
            cancel();
          });
        });
        return opened;
      } catch (error) {
        cancel();
        throw error;
      }
    },
    [ref],
  );
}
