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
    let observer: ResizeObserver | null = null;
    let frame = 0;
    let cancelled = false;
    const attach = () => {
      const el = ref.current;
      if (el === null) {
        // 弹层（Portal）内容可比宿主组件晚一拍提交：ref 尚空时逐帧重试、
        // 挂上即观察——此前空 ref 静默早退会让观察永不建立（订正工作台
        // 实测：Dialog 内首帧挂 ref，宽度观察恒停初始值）；卸载即停
        if (!cancelled) frame = requestAnimationFrame(attach);
        return;
      }
      if (typeof ResizeObserver === "undefined") {
        setRef.current(projRef.current(el.offsetWidth)); // jsdom：一次性读数
        return;
      }
      observer = new ResizeObserver((entries) => {
        const next = projRef.current(entries[0]?.contentRect.width ?? 0);
        setValue((prev) => (Object.is(prev, next) ? prev : next));
      });
      observer.observe(el);
    };
    attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [ref, enabled]);
  return value;
}

/** 宽度原语（投影恒等）：需要原始像素宽度时用（如纸高换算） */
export function useObservedCssWidth(
  ref: React.RefObject<HTMLElement | null>,
): number {
  return useObservedCssValue(ref, (width) => width);
}
