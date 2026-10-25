import { useEffect, useRef, useState } from "react";
import "./reading-toolbar.css";

const EDITING =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, math-field, [contenteditable="true"]';
const OVERLAY = '[role="dialog"], [role="menu"]';

/** 只响应窄屏正文的用户滚动；保留导航布局尺寸，避免题面和笔迹坐标跳动。 */
export function useReadingToolbar({ blocked = false } = {}) {
  const ref = useRef<HTMLElement>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const desktop = window.matchMedia?.("(min-width: 1024px)");
    let lastY = Math.max(0, window.scrollY);
    let distance = 0;
    let direction = 0;
    let userUntil = 0;
    let concealed = false;
    let keyboardNavigation = false;
    const show = () => {
      concealed = false;
      setHidden(false);
    };
    const reset = () => {
      lastY = Math.max(0, window.scrollY);
      distance = 0;
      direction = 0;
      userUntil = 0;
    };
    const locked = () =>
      blocked ||
      desktop?.matches ||
      (keyboardNavigation && element.contains(document.activeElement)) ||
      document.activeElement?.matches(EDITING) ||
      document.querySelector(OVERLAY) !== null ||
      element.querySelector('[role="alert"]') !== null;
    const authorize = (event: Event) => {
      if (event.type !== "keydown") keyboardNavigation = false;
      if (event instanceof TouchEvent && event.touches.length > 1) {
        reset();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest(`${EDITING}, ${OVERLAY}, canvas`)
      )
        return;
      userUntil = performance.now() + 1200;
    };
    const keyDown = (event: KeyboardEvent) => {
      keyboardNavigation = true;
      if (element.contains(document.activeElement)) show();
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        authorize(event);
      else reset();
    };
    const focusIn = () => {
      reset();
      if (element.contains(document.activeElement)) show();
    };
    const scroll = () => {
      // Safari 顶部/底部回弹不能被识别成反向阅读。
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const y = Math.max(0, Math.min(window.scrollY, max > 0 ? max : Infinity));
      const delta = y - lastY;
      lastY = y;
      if (locked() || y <= Math.max(64, element.offsetHeight)) {
        distance = 0;
        show();
        return;
      }
      if (performance.now() > userUntil || userUntil === 0 || delta === 0)
        return;
      const nextDirection = Math.sign(delta);
      if (direction !== nextDirection) distance = 0;
      direction = nextDirection;
      distance += Math.abs(delta);
      if (direction > 0 && distance >= 24 && !concealed) {
        concealed = true;
        setHidden(true);
      } else if (direction < 0 && distance >= 12 && concealed) show();
    };
    const resize = () => {
      reset();
      show();
    };
    const notices = new MutationObserver(() => {
      if (element.querySelector('[role="alert"]')) show();
    });
    notices.observe(element, { childList: true, subtree: true });
    show();
    document.addEventListener("wheel", authorize, { passive: true });
    document.addEventListener("touchmove", authorize, { passive: true });
    document.addEventListener("pointerdown", reset, true);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("focusin", focusIn);
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", resize);
    desktop?.addEventListener("change", resize);
    return () => {
      notices.disconnect();
      document.removeEventListener("wheel", authorize);
      document.removeEventListener("touchmove", authorize);
      document.removeEventListener("pointerdown", reset, true);
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("focusin", focusIn);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", resize);
      desktop?.removeEventListener("change", resize);
    };
  }, [blocked]);
  return { ref, hidden };
}
