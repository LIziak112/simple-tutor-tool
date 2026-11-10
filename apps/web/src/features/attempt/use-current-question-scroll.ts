import { useEffect, useRef } from "react";

/** 只滚动答题卡题号区，保留题面位置与焦点。 */
export function useCurrentQuestionScroll<ScrollElement extends HTMLElement>(
  currentId: string | null,
  filter: string,
) {
  const grid = useRef<ScrollElement>(null);
  const currentTile = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(filter): 筛选改变题号位置时重新对齐。
  useEffect(() => {
    const scroller = grid.current;
    const tile = currentTile.current;
    if (currentId === null || !scroller || !tile) return;
    const alignCurrentTile = () => {
      const height = scroller.clientHeight;
      if (!height) return;
      const bounds = scroller.getBoundingClientRect();
      const target = tile.getBoundingClientRect();
      // 弹层缩放期间，视口距离须换回滚动容器的布局距离。
      const scale = bounds.height / height || 1;
      const padding = 4 * scale;
      if (target.top < bounds.top + padding)
        scroller.scrollTop += (target.top - bounds.top - padding) / scale;
      else if (target.bottom > bounds.bottom - padding)
        scroller.scrollTop += (target.bottom - bounds.bottom + padding) / scale;
    };
    alignCurrentTile();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(alignCurrentTile);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [currentId, filter]);

  return { grid, currentTile };
}
