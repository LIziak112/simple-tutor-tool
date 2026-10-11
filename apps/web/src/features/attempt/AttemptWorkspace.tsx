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
    const header = element.querySelector<HTMLElement>(
      '[data-slot="attempt-header"]',
    );
    const footer = element.querySelector<HTMLElement>(
      '[data-slot="attempt-bottom-bar"]',
    );
    const measure = () => {
      element.style.setProperty(
        "--attempt-header-height",
        `${header?.getBoundingClientRect().height || 64}px`,
      );
      element.style.setProperty(
        "--attempt-footer-height",
        `${footer?.getBoundingClientRect().height || 64}px`,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    if (footer) observer.observe(footer);
    return () => observer.disconnect();
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
