import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/** 专注阅读复用唯一正文与输入。题目和纸面始终留在原树内，草稿由上层持有。 */
export function AiReadingWorkspace({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  const [headings, setHeadings] = useState<
    readonly { id: string; text: string }[]
  >([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<HTMLButtonElement>(null);
  const readingTopRef = useRef(0);
  const prefix = useId();
  useEffect(() => {
    const root = rootRef.current;
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
          heading.style.scrollMarginTop = "6rem";
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
  }, [focused, prefix]);
  const outline =
    headings.length > 1 ? (
      <details className="min-w-0 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-primary focus-visible:outline-2 focus-visible:outline-ring">
          按段落阅读（{headings.length}）
        </summary>
        <nav aria-label="回复目录" className="flex flex-col items-start">
          {headings.map((heading) => (
            <button
              key={heading.id}
              type="button"
              className="min-h-11 max-w-full rounded px-2 text-left break-words text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
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
      </details>
    ) : null;
  const content = (
    <>
      {focused && outline}
      <div ref={rootRef} className="min-w-0">
        {children}
      </div>
    </>
  );
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {!focused && outline}
        <Button
          ref={entryRef}
          type="button"
          variant="ghost"
          className="min-h-11 self-end"
          onClick={() => {
            readingTopRef.current = window.scrollY;
            setFocused(true);
          }}
        >
          专注阅读
        </Button>
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
              {content}
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        content
      )}
    </>
  );
}
