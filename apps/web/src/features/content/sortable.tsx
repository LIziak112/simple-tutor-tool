import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * dnd-kit 拖拽排序基建（T1.12）：
 * - SortableZone：DndContext + SortableContext（垂直列表），松手时回调新顺序 ids；
 * - SortableItem：useSortable 封装（setNodeRef + transform 样式由调用方落到行元素）；
 * - DragHandle：≥44px 拖拽把手（键盘可用：聚焦后空格拾起、方向键移动、空格放下）。
 * 顺序计算/乐观更新/请求都在 reorder-logic + 页面层，本文件只管手势与可访问性。
 */

export interface SortableZoneProps {
  /** 本列表全部 item id（完整顺序，作为 SortableContext items） */
  ids: readonly string[];
  /** 松手后新的完整顺序（父组件做乐观更新 + 调 reorder 接口 + 失败回滚） */
  onReorder: (orderedIds: string[]) => void;
  /** 列表可访问名称（如「练习四 的题目列表」） */
  ariaLabel: string;
  children: ReactNode;
}

export function SortableZone({
  ids,
  onReorder,
  ariaLabel,
  children,
}: SortableZoneProps) {
  // distance: 5px —— 把手上的点击（无拖动）不触发排序，避免误触
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove([...ids], oldIndex, newIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements: {
          onDragStart: () => "已拾起，按上下方向键移动，空格放下",
          onDragEnd: () => "已放下",
          onDragCancel: () => "已取消拖拽",
          onDragOver: () => undefined,
        },
      }}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        {/* fieldset（group 语义）：把可访问名称给到整块可排序区域（内部列表/表格另有自身语义） */}
        <fieldset aria-label={ariaLabel} className="m-0 min-w-0 border-0 p-0">
          {children}
        </fieldset>
      </SortableContext>
    </DndContext>
  );
}

/** useSortable 的结果（调用方把 ref/style/attributes 落到行元素上） */
export type SortableHandleProps = ReturnType<
  typeof useSortable
>["attributes"] & {
  ref: (element: HTMLElement | null) => void;
  style: CSSProperties;
};

export interface SortableItemProps {
  id: string;
  children: (handle: {
    /** 展开到行元素（ref + transform 样式 + role/aria） */
    rowProps: SortableHandleProps;
    /** 展开到把手按钮（pointer/keyboard 监听） */
    handleListeners: Record<string, unknown> | undefined;
    isDragging: boolean;
  }) => ReactNode;
}

export function SortableItem({ id, children }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
    opacity: isDragging ? 0.8 : undefined,
  };
  return (
    <>
      {children({
        rowProps: { ...attributes, ref: setNodeRef, style },
        handleListeners: listeners,
        isDragging,
      })}
    </>
  );
}

/** 拖拽把手（GripVertical，≥44px 触控目标；聚焦后键盘可拖） */
export function DragHandle({
  label,
  listeners,
}: {
  /** 可访问名称（如「拖拽调整 练习四-1 的顺序」） */
  label: string;
  listeners: Record<string, unknown> | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
      {...listeners}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}
