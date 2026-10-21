import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { AiReadingMemoryContext } from "./AiReadingWorkspace";

const SectionsContext = createContext<{
  expanded: readonly string[] | null;
  update: (ids: readonly string[]) => void;
  prefix: string;
  readingKey: string;
} | null>(null);
export function AiReplySectionsProvider({
  children,
  readingKey,
}: {
  children: ReactNode;
  readingKey: string;
}) {
  const memory = useContext(AiReadingMemoryContext);
  const key = `sections:${readingKey}`;
  const [expanded, setExpanded] = useState<readonly string[] | null>(
    () => memory?.get(key)?.sections ?? null,
  );
  const prefix = useId();
  return (
    <SectionsContext
      value={{
        expanded,
        prefix,
        readingKey,
        update: (ids) => {
          setExpanded(ids);
          memory?.set(key, { sections: ids });
        },
      }}
    >
      {children}
    </SectionsContext>
  );
}
export function AiReplySection({
  id,
  initialOpen,
  children,
}: {
  id: string;
  initialOpen: boolean;
  children: ReactNode;
}) {
  const context = useContext(SectionsContext);
  const expanded = context?.expanded;
  const open = expanded == null ? initialOpen : expanded.includes(id);
  return (
    <details
      id={`${context?.prefix}-${id}`}
      data-ai-section={`${context?.readingKey}:${id}`}
      data-section-id={id}
      open={open}
      className="ai-reply-section scroll-mt-4 border-b border-border/70 py-1 [overflow-anchor:none] last:border-b-0"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (nextOpen === open || !context) return;
        const ids = context.expanded ?? [
          event.currentTarget.parentElement?.querySelector<HTMLElement>(
            "[data-ai-section]",
          )?.dataset.sectionId ?? id,
        ];
        context.update(
          nextOpen
            ? [...new Set([...ids, id])]
            : ids.filter((item) => item !== id),
        );
      }}
    >
      {children}
    </details>
  );
}
export function AiReplySectionActions({ ids }: { ids: readonly string[] }) {
  const context = useContext(SectionsContext);
  const all = context?.expanded?.length === ids.length;
  return (
    <div className="not-prose flex min-w-0 items-center justify-between gap-2 pb-2 text-sm text-muted-foreground">
      <span>分段阅读 · {ids.length} 节</span>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 shrink-0 px-2"
        onClick={() => context?.update(all ? ids.slice(0, 1) : ids)}
      >
        {all ? "收起其余" : "展开全部"}
      </Button>
    </div>
  );
}
