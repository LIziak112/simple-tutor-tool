import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { OutlineItem } from "./outline";
import { OutlineInlineMath } from "./outline-inline-math";

/** 分组只影响展示；导航始终保留全文 H2/H3 的原始下标。 */
export function LectureOutline({
  items,
  currentIndex,
  onNavigate,
}: {
  items: OutlineItem[];
  currentIndex: number | null;
  onNavigate: (index: number) => void;
}) {
  const prefix = useId();
  const groups = useMemo(() => {
    const result: Array<{
      item: OutlineItem;
      index: number;
      children: Array<{ item: OutlineItem; index: number }>;
    }> = [];
    items.forEach((item, index) => {
      const previous = result.at(-1);
      if (item.depth === 3 && previous?.item.depth === 2) {
        previous.children.push({ item, index });
      } else {
        result.push({ item, index, children: [] });
      }
    });
    return result;
  }, [items]);
  const currentGroup = groups.find(
    (group) =>
      group.index === currentIndex ||
      group.children.some((child) => child.index === currentIndex),
  );
  const currentGroupIndex = currentGroup?.index;
  const [expanded, setExpanded] = useState<Map<number, boolean>>(
    () => new Map(),
  );
  useEffect(() => {
    if (currentGroupIndex === undefined) return;
    // 到达新章时恢复自动展开；其他章仅保留学生主动设置的状态。
    setExpanded((previous) => {
      if (!previous.has(currentGroupIndex)) return previous;
      const next = new Map(previous);
      next.delete(currentGroupIndex);
      return next;
    });
  }, [currentGroupIndex]);

  function entry(item: OutlineItem, index: number) {
    const current = currentIndex === index;
    return (
      <button
        type="button"
        onClick={() => onNavigate(index)}
        aria-current={current ? "location" : undefined}
        className={`min-h-11 min-w-0 flex-1 rounded-lg border-l-2 px-3 py-2 text-left text-sm leading-relaxed break-words focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring hover:bg-muted ${current ? "border-primary bg-primary/10 font-semibold text-primary" : `border-transparent ${item.depth === 3 ? "text-muted-foreground" : "font-medium text-foreground"}`}`}
      >
        <OutlineInlineMath text={item.text} />
      </button>
    );
  }

  return (
    <nav aria-label="讲义目录">
      <ol className="flex flex-col gap-2">
        {groups.map((group) => {
          const open =
            expanded.get(group.index) ?? currentGroupIndex === group.index;
          const childrenId = `${prefix}-${group.index}`;
          return (
            <li key={group.item.id}>
              <fieldset aria-label={group.item.text} className="min-w-0">
                <div className="flex items-start gap-1">
                  {entry(group.item, group.index)}
                  {group.children.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${open ? "收起" : "展开"}${group.item.text}的子目录`}
                      aria-expanded={open}
                      aria-controls={childrenId}
                      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Map(previous);
                          next.set(group.index, !open);
                          return next;
                        })
                      }
                    >
                      <ChevronDown
                        aria-hidden
                        className={`size-4 ${open ? "" : "-rotate-90"}`}
                      />
                    </button>
                  )}
                </div>
                {group.children.length > 0 && (
                  <ol
                    id={childrenId}
                    hidden={!open}
                    className="ml-4 mt-1 flex flex-col border-l border-border pl-2"
                  >
                    {group.children.map((child) => (
                      <li key={child.item.id} className="flex">
                        {entry(child.item, child.index)}
                      </li>
                    ))}
                  </ol>
                )}
              </fieldset>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
