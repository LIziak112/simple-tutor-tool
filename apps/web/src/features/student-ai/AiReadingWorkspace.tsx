import { ChevronDown, List, Maximize2 } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/** 专注阅读复用唯一正文与输入。题目和纸面始终留在原树内，草稿由上层持有。 */
export function AiReadingWorkspace({
  children,
  context,
}: {
  children: ReactNode;
  context?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [headings, setHeadings] = useState<
    readonly { id: string; text: string }[]
  >([]);
  const entryRef = useRef<HTMLButtonElement>(null);
  const readingTopRef = useRef(0);
  const prefix = useId();
  // 弹层挂载晚于外层 effect；用节点回调在真实阅读容器就绪后建立目录。
  const readingRef = useCallback(
    (root: HTMLDivElement | null) => {
      if (!root) return;
      root.dataset.readingPresentation = focused ? "focused" : "inline";
      const update = () => {
        const next = Array.from(
          root.querySelectorAll<HTMLElement>(
            ".ai-reply-markdown h1, .ai-reply-markdown h2, .ai-reply-markdown h3",
          ),
        )
          .slice(0, 30)
          .map((heading, index) => {
            heading.id = `${prefix}-heading-${index}`;
            heading.style.scrollMarginTop = focused
              ? "1rem"
              : "calc(var(--attempt-header-height, 64px) + 16px)";
            return { id: heading.id, text: heading.textContent ?? "" };
          });
        setHeadings((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
      };
      update();
      const observer = new MutationObserver(update);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      return () => observer.disconnect();
    },
    [focused, prefix],
  );
  const outlineId = `${prefix}-outline`;
  const outlineToggle =
    headings.length > 1 ? (
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 gap-2 px-2 text-muted-foreground"
        aria-expanded={outlineOpen}
        aria-controls={outlineId}
        onClick={() => setOutlineOpen((previous) => !previous)}
      >
        <List aria-hidden className="size-4" />
        回复目录 · {headings.length} 节
        <ChevronDown
          aria-hidden
          className={`size-3.5 ${outlineOpen ? "rotate-180" : ""}`}
        />
      </Button>
    ) : null;
  const outline =
    headings.length > 1 && outlineOpen ? (
      <nav
        id={outlineId}
        aria-label="回复目录"
        className="mb-4 grid min-w-0 gap-1 rounded-lg bg-muted/40 p-2 text-sm"
      >
        {headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            className="min-h-11 max-w-full rounded px-3 py-2 text-start break-words text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              const node = document.getElementById(heading.id);
              node?.scrollIntoView?.({
                block: "start",
                behavior: "instant",
              });
              if (node) {
                node.tabIndex = -1;
                node.focus({ preventScroll: true });
              }
            }}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    ) : null;
  const content = (
    <>
      {outline}
      <div ref={readingRef} className="min-w-0">
        {children}
      </div>
    </>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {context}
        <div className="ms-auto flex flex-wrap items-center gap-1">
          {!focused && outlineToggle}
          <Button
            ref={entryRef}
            type="button"
            variant="ghost"
            className="min-h-11 gap-2 px-2 text-muted-foreground"
            onClick={() => {
              readingTopRef.current = window.scrollY;
              setFocused(true);
            }}
          >
            <Maximize2 aria-hidden className="size-4" />
            专注阅读
          </Button>
        </div>
      </div>
      {focused ? (
        <Dialog open onOpenChange={setFocused}>
          <DialogContent
            className="flex h-[min(90dvh,60rem)] w-[calc(100%-1.5rem)] max-w-4xl flex-col gap-3 overflow-hidden p-4 sm:max-w-4xl sm:p-6"
            onEscapeKeyDown={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!entryRef.current?.isConnected) return;
              entryRef.current.focus({ preventScroll: true });
              window.scrollTo({
                top: readingTopRef.current,
                behavior: "instant",
              });
            }}
          >
            <DialogTitle className="pr-10">本题 AI 回复</DialogTitle>
            <DialogDescription>
              读完后关闭阅读，回到原题继续尝试。
            </DialogDescription>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="mx-auto w-full max-w-[40rem]">
                {outlineToggle}
                {content}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        content
      )}
    </>
  );
}
