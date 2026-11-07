import { cn } from "cn";
import { ArrowRight, Check, CircleHelp, Flag } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  getAnnotationView,
  subscribeAnnotationStore,
} from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import { getNoteView, subscribeNoteStore } from "@/features/notes/note-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import {
  type QuestionNavigationItem,
  QuestionNavigationTile,
} from "./QuestionNavigator";

const answerFilters = [
  { id: "all", label: "全部" },
  { id: "empty", label: "未填写" },
  { id: "partial", label: "部分作答" },
  { id: "filled", label: "已填写" },
] as const;
const markFilters = [
  { id: "flagged", label: "待检查", Icon: Flag },
  { id: "unsure", label: "不会", Icon: CircleHelp },
] as const;
const filters = [...answerFilters, ...markFilters];
export type AnswerCardFilter = (typeof filters)[number]["id"];

/** 只读已恢复的卷内正文。弹层关闭时不订阅逐笔更新。 */
function useAnswerCardWorkIds(
  attemptId: string,
  questionIds: readonly string[],
  enabled: boolean,
): ReadonlySet<string> | null {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    const stopNotes = subscribeNoteStore(refresh);
    const stopAnnotations = subscribeAnnotationStore(refresh);
    refresh();
    return () => {
      stopNotes();
      stopAnnotations();
    };
  }, [enabled]);

  if (!enabled) return null;
  const notes = currentNoteSession();
  const annotations = currentAnnotationSession();
  if (!notes || !annotations) return null;
  return new Set(
    questionIds.filter((questionId) => {
      const scope = { attemptId, questionId, phase: "scratch" as const };
      return (
        (getNoteView(notes, scope)?.doc?.ink.strokes.length ?? 0) > 0 ||
        (getAnnotationView(annotations, scope)?.doc?.strokes.length ?? 0) > 0
      );
    }),
  );
}

export function LiveAttemptAnswerCard({
  attemptId,
  questionIds,
  materialsReady,
  ...props
}: Omit<Parameters<typeof AttemptAnswerCard>[0], "workIds"> & {
  attemptId: string;
  questionIds: readonly string[];
  materialsReady: boolean;
}) {
  const workIds = useAnswerCardWorkIds(attemptId, questionIds, materialsReady);
  return <AttemptAnswerCard {...props} workIds={workIds} />;
}

export function AttemptAnswerCard({
  items,
  currentId,
  filter,
  onFilterChange,
  workIds,
  onJump,
  locked = false,
  sidebar = false,
  showNextUnanswered = false,
}: {
  items: readonly QuestionNavigationItem[];
  currentId: string | null;
  filter: AnswerCardFilter;
  onFilterChange: (filter: AnswerCardFilter) => void;
  workIds: ReadonlySet<string> | null;
  onJump: (id: string) => void;
  locked?: boolean;
  sidebar?: boolean;
  showNextUnanswered?: boolean;
}) {
  const grid = useRef<HTMLOListElement>(null);
  const currentTile = useRef<HTMLButtonElement>(null);
  const needsWork = workIds === null;
  const activeFilter =
    needsWork && (filter === "empty" || filter === "partial") ? "all" : filter;
  const activeLabel = filters.find(({ id }) => id === activeFilter)?.label;
  const visible = items
    .map((item) => {
      const completion = item.completion.state;
      const state =
        completion !== "empty"
          ? completion
          : needsWork
            ? ("unknown" as const)
            : workIds.has(item.id)
              ? ("partial" as const)
              : completion;
      return { item, state };
    })
    .filter(({ item, state }) => {
      if (activeFilter === "all") return true;
      if (activeFilter === "flagged") return item.flagged;
      if (activeFilter === "unsure") return item.unsure;
      return state === activeFilter;
    });
  const current = items.find((item) => item.id === currentId);
  const currentVisible = visible.some(({ item }) => item.id === currentId);
  const currentIndex = items.findIndex((item) => item.id === currentId);
  const nextUnanswered = showNextUnanswered
    ? [
        ...items.slice(currentIndex + 1),
        ...items.slice(0, currentIndex + 1),
      ].find(
        (item) =>
          item.completion.state !== "filled" && !item.practice?.submitted,
      )
    : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换筛选或当前题后重新检查滚动边界。
  useEffect(() => {
    const scroller = grid.current;
    const tile = currentTile.current;
    if (!currentVisible || !scroller || !tile) return;
    const alignCurrentTile = () => {
      if (!scroller.clientHeight) return;
      const bounds = scroller.getBoundingClientRect();
      const target = tile.getBoundingClientRect();
      if (target.top < bounds.top + 4)
        scroller.scrollTop += target.top - bounds.top - 4;
      else if (target.bottom > bounds.bottom - 4)
        scroller.scrollTop += target.bottom - bounds.bottom + 4;
    };
    alignCurrentTile();
    // 窄屏时桌面侧栏没有布局尺寸，跨断点显示时重新对齐当前题。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(alignCurrentTile);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [activeFilter, currentId, currentVisible]);

  function filterButton(option: (typeof filters)[number]) {
    const selected = option.id === activeFilter;
    return (
      <button
        key={option.id}
        type="button"
        aria-pressed={selected}
        disabled={
          needsWork && (option.id === "empty" || option.id === "partial")
        }
        onClick={() => {
          if (filter === option.id) return;
          if (grid.current) grid.current.scrollTop = 0;
          onFilterChange(option.id);
        }}
        className={cn(
          "inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-lg border border-transparent px-1 text-sm font-medium outline-none enabled:active:opacity-75 disabled:opacity-50 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "Icon" in option && "bg-muted",
          selected && "border-primary bg-card font-semibold text-primary",
        )}
      >
        {"Icon" in option && (
          <option.Icon aria-hidden size={14} absoluteStrokeWidth />
        )}
        {option.label}
      </button>
    );
  }

  return (
    <nav
      aria-label="答题卡"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
    >
      {sidebar ? (
        <select
          aria-label="筛选题目"
          className="min-h-11 w-full shrink-0 rounded-md border border-input bg-card px-2 text-sm"
          value={activeFilter}
          onChange={(event) => {
            const option = filters.find(({ id }) => id === event.target.value);
            if (!option) return;
            if (grid.current) grid.current.scrollTop = 0;
            onFilterChange(option.id);
          }}
        >
          {filters.map(({ id, label }) => (
            <option
              key={id}
              value={id}
              disabled={needsWork && (id === "empty" || id === "partial")}
            >
              {label}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-2">
          <fieldset
            aria-label="作答状态"
            className="grid min-w-0 basis-full grid-cols-4 gap-0.5 rounded-xl bg-muted p-1 sm:min-w-[280px] sm:flex-1 sm:basis-auto"
          >
            {answerFilters.map(filterButton)}
          </fieldset>
          <fieldset
            aria-label="个人标记"
            className="grid w-[156px] grid-cols-2 gap-2 sm:w-[168px]"
          >
            {markFilters.map(filterButton)}
          </fieldset>
        </div>
      )}
      <div className="flex min-h-6 shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p role="status">
          {visible.length > 0
            ? `${activeLabel} ${visible.length} 题`
            : activeFilter === "all"
              ? "暂无题目"
              : `没有「${activeLabel}」的题目`}
          {needsWork && " · 作答状态尚未确认"}
        </p>
        {current && (
          <span className="rounded-md bg-accent px-2 py-1 text-accent-foreground">
            当前第 {current.index + 1} 题
          </span>
        )}
      </div>
      <ol
        ref={grid}
        className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,44px)] content-start justify-start gap-2 overflow-y-auto overscroll-contain p-1"
      >
        {visible.map(({ item, state }) => (
          <li key={item.id}>
            <QuestionNavigationTile
              ref={item.id === currentId ? currentTile : undefined}
              item={item}
              current={item.id === currentId}
              answerCardState={state}
              locked={locked}
              onJump={onJump}
            />
          </li>
        ))}
      </ol>
      {showNextUnanswered && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full shrink-0 justify-between px-3"
          disabled={locked || !nextUnanswered}
          onClick={() => nextUnanswered && onJump(nextUnanswered.id)}
        >
          {nextUnanswered
            ? "下一道未答"
            : items.length === 0
              ? "暂无题目"
              : "全部已填写"}
          {nextUnanswered ? (
            <ArrowRight aria-hidden className="size-4" />
          ) : (
            <Check aria-hidden className="size-4" />
          )}
        </Button>
      )}
    </nav>
  );
}
