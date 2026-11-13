import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

interface ReadingPosition {
  anchor: string;
  offset: number;
}

export function createReplySectionsStore() {
  let expanded: readonly string[] | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => expanded,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(ids: readonly string[]) {
      expanded = ids;
      for (const listener of listeners) listener();
    },
  };
}

export function createAiReadingMemory() {
  const positions = new Map<string, ReadingPosition>();
  const sections = new Map<
    string,
    ReturnType<typeof createReplySectionsStore>
  >();
  return {
    positions,
    sectionsOf(key: string) {
      let store = sections.get(key);
      if (!store) {
        store = createReplySectionsStore();
        sections.set(key, store);
      }
      return store;
    },
  };
}

const AI_READING_KEY = ["student", "ai-reading"] as const;
export const AiReadingMemoryContext = createContext<ReturnType<
  typeof createAiReadingMemory
> | null>(null);
export function useAiReadingMemory(attemptId: string) {
  const client = useQueryClient();
  return useMemo(() => {
    const key = [...AI_READING_KEY, attemptId];
    let memory =
      client.getQueryData<ReturnType<typeof createAiReadingMemory>>(key);
    if (!memory) {
      memory = createAiReadingMemory();
      client.setQueryDefaults(AI_READING_KEY, { gcTime: Infinity });
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
    const saved = memory.positions.get(readingKey);
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
      if (!saved) return true;
      const anchor = Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-ai-section], [data-ai-reading-block]",
        ),
      ).find((node) => anchorKey(node) === saved.anchor);
      if (!anchor) return false;
      const delta = anchor.getBoundingClientRect().top - top() - saved.offset;
      if (host) host.scrollTop += delta;
      else window.scrollBy({ top: delta, behavior: "instant" });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    const remember = () => {
      observer.disconnect();
      const nodes = sections();
      const anchor =
        nodes.find((node) => node.getBoundingClientRect().bottom > top()) ??
        nodes.at(-1);
      const key = anchor && anchorKey(anchor);
      if (anchor && key !== undefined)
        memory.positions.set(readingKey, {
          anchor: key,
          offset: anchor.getBoundingClientRect().top - top(),
        });
    };
    if (!restore())
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-ai-section", "data-ai-reading-block"],
      });
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
