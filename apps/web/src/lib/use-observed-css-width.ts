/**
 * 元素 CSS 宽度观察（自 note-layout 上移 lib，T6R.9 复审⑩——宽度观察是
 * 通用能力，草稿布局与纸高换算共用）。
 *
 * ResizeObserver 存在时跟随容器尺寸变化；不存在（jsdom）或未就绪时回退
 * offsetWidth 读数一次。**注意**：回调逐帧触发 setState——消费方若只关心
 * 阈值结论（如分栏判定），请用量化包装（note-layout.useNoteSideUsable），
 * 避免整卡每帧重渲染。
 */
import { useEffect, useRef, useState } from "react";

export function useObservedCssWidth(
  ref: React.RefObject<HTMLElement | null>,
): number {
  const [width, setWidth] = useState(0);
  // 回调经 ref 存放：ResizeObserver 只建一次，回调读最新 setter
  const setRef = useRef(setWidth);
  setRef.current = setWidth;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") {
      setRef.current(el.offsetWidth); // jsdom/极老浏览器：一次性读数
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setRef.current(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
