import { type ReactNode, useEffect, useRef } from "react";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";

export function AttemptWorkspace({ children }: { children: ReactNode }) {
  useStudentWorkspace();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const viewport = window.visualViewport;
    let editing = false;
    const update = () => {
      const keyboardOpen =
        editing &&
        viewport != null &&
        viewport.scale === 1 &&
        window.innerHeight - viewport.height - viewport.offsetTop > 120;
      element.dataset.keyboardOpen = String(keyboardOpen);
    };
    const isInput = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      target.matches(
        'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
      );
    const focusIn = (event: FocusEvent) => {
      editing = isInput(event.target);
      update();
    };
    const focusOut = (event: FocusEvent) => {
      editing = isInput(event.relatedTarget);
      update();
    };
    update();
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", focusOut);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", focusOut);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    let header: HTMLElement | null = null;
    let footer: HTMLElement | null = null;
    const setMeasurement = (name: string, value: number) => {
      const next = `${value}px`;
      if (element.style.getPropertyValue(name) !== next)
        element.style.setProperty(name, next);
    };
    const measure = () => {
      // DOMRect含CSS缩放，布局变量须还原为未缩放单位。
      const visualWidth = element.getBoundingClientRect().width;
      const scale =
        element.offsetWidth > 0 && visualWidth > 0
          ? visualWidth / element.offsetWidth
          : 1;
      setMeasurement(
        "--attempt-header-height",
        (header?.getBoundingClientRect().height || 64 * scale) / scale,
      );
      setMeasurement(
        "--attempt-footer-height",
        (footer?.getBoundingClientRect().height || 64 * scale) / scale,
      );
      setMeasurement("--attempt-viewport-height", window.innerHeight / scale);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    const discover = () => {
      const nextHeader = element.querySelector<HTMLElement>(
        '[data-slot="attempt-header"]',
      );
      const nextFooter = element.querySelector<HTMLElement>(
        '[data-slot="attempt-bottom-bar"]',
      );
      if (header === nextHeader && footer === nextFooter) return;
      if (header) observer?.unobserve(header);
      if (footer) observer?.unobserve(footer);
      header = nextHeader;
      footer = nextFooter;
      if (header) observer?.observe(header);
      if (footer) observer?.observe(footer);
      measure();
    };
    discover();
    measure();
    observer?.observe(element);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    const mutation = new MutationObserver(discover);
    mutation.observe(element, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);
  return (
    <div
      ref={root}
      data-slot="attempt-workspace"
      className="group/workspace flex min-w-0 flex-col gap-4 pb-[calc(var(--attempt-footer-height,64px)+24px)]"
    >
      {children}
    </div>
  );
}
