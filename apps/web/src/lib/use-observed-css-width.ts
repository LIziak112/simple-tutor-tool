/**
 * 元素 CSS 尺寸观察（自 note-layout 上移 lib，T6R.9 复审⑩⑭——尺寸观察是
 * 通用能力，草稿布局与纸高换算共用）。
 *
 * useObservedCssValue：观察容器宽度并经 project 投影——**只在投影结论变化
 * 时 setState**（Object.is 量化），旋转/分屏拖动的逐帧回调不引发重渲染；
 * enabled=false 不订阅观察（effect 内早退，非条件 hook）。
 * ResizeObserver 不存在（jsdom）时回退 offsetWidth 读数一次（不模拟
 * 0 宽报告——该差异不进单测口径，真实行为由 E2E/真机覆盖）。
 */
import { useEffect, useRef, useState } from "react";

export function useObservedCssValue<T>(
  ref: React.RefObject<HTMLElement | null>,
  project: (width: number) => T,
  opts: { enabled?: boolean } = {},
): T {
  const enabled = opts.enabled ?? true;
  const [value, setValue] = useState<T>(() => project(0));
  // 回调经 ref 存放：ResizeObserver 只建一次，回调读最新 setter/project
  const setRef = useRef(setValue);
  setRef.current = setValue;
  const projRef = useRef(project);
  projRef.current = project;
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") {
      setRef.current(projRef.current(el.offsetWidth)); // jsdom：一次性读数
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const next = projRef.current(entries[0]?.contentRect.width ?? 0);
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return value;
}

/** 宽度原语（投影恒等）：需要原始像素宽度时用（如纸高换算） */
export function useObservedCssWidth(
  ref: React.RefObject<HTMLElement | null>,
): number {
  return useObservedCssValue(ref, (width) => width);
}
