import { Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/** 同一子树切换CSS外框；不移动host、不复制纸面、不改变正文身份。 */
export function PaperPresentation({
  fullscreen,
  label,
  context,
  heading,
  onClose,
  children,
}: {
  fullscreen: boolean;
  label: string;
  context?: ReactNode;
  heading?: string;
  onClose(): void | Promise<void>;
  children: ReactNode;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const normalHeight = useRef(0);
  useLayoutEffect(() => {
    if (fullscreen || !placeholder.current) return;
    const element = placeholder.current;
    const measure = () => {
      normalHeight.current = element.getBoundingClientRect().height;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [fullscreen]);
  useEffect(() => {
    if (!fullscreen || !frame.current || !placeholder.current) return;
    const element = frame.current;
    const holder = placeholder.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const previousHeight = holder.style.height;
    holder.style.height = `${normalHeight.current}px`;
    document.body.style.overflow = "hidden";
    // 外框位于原题卡内，逐层锁同级背景，不能把含纸面的祖先设为inert。
    const locked: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement = element;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        locked.push({ element: sibling, inert: sibling.hasAttribute("inert") });
        sibling.setAttribute("inert", "");
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    closeButton.current?.focus({ preventScroll: true });
    const hasNestedOverlay = () =>
      [
        ...document.querySelectorAll(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        ),
      ].some((overlay) => overlay !== element);
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        hasNestedOverlay()
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        void closeRef.current();
      }
      if (event.key !== "Tab") return;
      const buttons = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ].filter(
        (item) =>
          !item.closest("[hidden], [inert]") &&
          getComputedStyle(item).visibility !== "hidden",
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !element.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !element.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("keydown", keyDown);
      for (const saved of locked)
        saved.element.toggleAttribute("inert", saved.inert);
      document.body.style.overflow = previousOverflow;
      holder.style.height = previousHeight;
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [fullscreen]);
  return (
    <div ref={placeholder} data-slot="paper-presentation" className="min-w-0">
      <div
        ref={frame}
        {...(fullscreen
          ? { role: "dialog", "aria-modal": true, "aria-label": label }
          : {})}
        data-state={fullscreen ? "open" : "closed"}
        data-slot="paper-frame"
        className={
          fullscreen
            ? "fixed inset-0 z-50 flex h-dvh min-w-0 flex-col bg-background pb-[env(safe-area-inset-bottom)]"
            : "min-w-0"
        }
      >
        <header
          hidden={!fullscreen}
          className="shrink-0 border-b border-border bg-card px-3 py-2"
        >
          <div className="flex min-h-11 items-start justify-between gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="mb-1 font-medium">{heading ?? label}</p>
              {context && (
                <details open>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    题干
                  </summary>
                  <div className="max-h-[max(48px,calc(28dvh-88px))] overflow-y-auto pt-1">
                    {context}
                  </div>
                </details>
              )}
            </div>
            <Button
              ref={closeButton}
              variant="outline"
              className="size-11 shrink-0 p-0"
              aria-label="退出全屏"
              title="退出全屏"
              onClick={() => void onClose()}
            >
              <Minimize2 aria-hidden />
            </Button>
          </div>
        </header>
        <div
          className={
            fullscreen
              ? "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
              : "min-w-0"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
