import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

interface ReadingState {
  sections?: readonly string[];
  anchor?: string | undefined;
  offset?: number;
}
export const AiReadingMemoryContext = createContext<Map<
  string,
  ReadingState
> | null>(null);
export function useAiReadingMemory(attemptId: string) {
  const client = useQueryClient();
  return useMemo(() => {
    const key = ["student", "ai-reading", attemptId];
    let memory = client.getQueryData<Map<string, ReadingState>>(key);
    if (!memory) {
      memory = new Map();
      client.setQueryDefaults(key, { gcTime: Infinity });
      client.setQueryData(key, memory);
    }
    return memory;
  }, [client, attemptId]);
}

/** 阅读状态留在学生角色内存；切换展示壳只更换滚动宿主，不复制正文与输入。 */
export function AiReadingWorkspace({
  children,
  readingKey = "current",
}: {
  children: ReactNode;
  readingKey?: string;
}) {
  const memory = useContext(AiReadingMemoryContext);
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !memory) return;
    const host = root.closest<HTMLElement>("[data-ai-scroll]");
    const scroller = host ?? window;
    const key = `position:${readingKey}`;
    let restoring = false;
    const top = () => (host ? host.getBoundingClientRect().top : 0);
    const sections = () => {
      const nodes = Array.from(
        root.querySelectorAll<HTMLElement>("[data-ai-section]"),
      );
      return nodes.length
        ? nodes
        : Array.from(
            root.querySelectorAll<HTMLElement>("[data-ai-reading-block]"),
          );
    };
    const anchorKey = (node: HTMLElement) =>
      node.dataset.aiSection ?? node.dataset.aiReadingBlock;
    const restore = () => {
      const state = memory.get(key);
      const anchor = sections().find(
        (node) => anchorKey(node) === state?.anchor,
      );
      if (!anchor || state?.offset === undefined) return;
      restoring = true;
      const delta = anchor.getBoundingClientRect().top - top() - state.offset;
      if (host) host.scrollTop += delta;
      else window.scrollBy({ top: delta, behavior: "instant" });
      restoring = false;
    };
    const remember = () => {
      if (restoring) return;
      const nodes = sections();
      const anchor =
        nodes.find((node) => node.getBoundingClientRect().bottom > top()) ??
        nodes.at(-1);
      if (anchor)
        memory.set(key, {
          anchor: anchorKey(anchor),
          offset: anchor.getBoundingClientRect().top - top(),
        });
    };
    restore();
    const observer = new MutationObserver(() => {
      if (sections().length) {
        restore();
        observer.disconnect();
      }
    });
    if (!sections().length)
      observer.observe(root, { childList: true, subtree: true });
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", remember);
    };
  }, [memory, readingKey]);
  return (
    <div ref={rootRef} className="min-w-0">
      {children}
    </div>
  );
}
