import { type ReactNode, useEffect, useRef } from "react";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";

export function AttemptWorkspace({ children }: { children: ReactNode }) {
  useStudentWorkspace();
  const root = useRef<HTMLDivElement>(null);
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
      className="flex min-w-0 flex-col gap-4 pb-[calc(var(--attempt-footer-height,64px)+24px)]"
    >
      {children}
    </div>
  );
}
