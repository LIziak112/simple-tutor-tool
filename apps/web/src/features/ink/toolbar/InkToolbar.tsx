import { cn } from "cn";
import {
  Eraser,
  Hand,
  Highlighter,
  MoreHorizontal,
  PenLine,
  Redo2,
  Shapes,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type InkToolboxState, selectInkTool } from "../engine/toolbox.ts";
import { INK_PEN_COLORS, type InkToolType } from "../engine/types.ts";
import { InkToolOptions, inkToolHasOptions } from "./InkToolOptions.tsx";
import { INK_HIGHLIGHTER_SWATCH, INK_TOOL_LABEL } from "./tool-labels.ts";

/** 工具栏按钮：44px 触控目标（ui-conventions iPad 硬性要求） */
export const inkToolButtonClass = "relative size-11 shrink-0 p-0";

const TOOL_ICON: Record<InkToolType, typeof PenLine> = {
  pen: PenLine,
  highlighter: Highlighter,
  eraser: Eraser,
  shape: Shapes,
  scroll: Hand,
};

const DEFAULT_TOOLS: readonly InkToolType[] = ["pen", "eraser"];

/**
 * 重做按钮占的宽度（44px 按钮 + 间距）。收进「更多」之后，要富余出这么宽才放回
 * 工具栏——少于它就放回，会立刻又被挤走，来回跳。
 */
const REDO_SLOT_PX = 46;

export interface InkToolbarProps {
  /** 可访问名前缀，如「第 1 题草稿纸」；工具栏名为「…工具栏」 */
  label: string;
  toolbox: InkToolboxState;
  onToolboxChange(next: InkToolboxState): void;
  /** 宿主提供的工具，按显示顺序；缺省笔与橡皮 */
  tools?: readonly InkToolType[];
  /** 工具是否带选项面板。历史 Excalidraw 画布不认颜色、粗细，传 false */
  toolOptions?: boolean;
  /** 覆盖个别工具的名字（历史 Excalidraw 画布把滚动位叫「选择」） */
  toolLabels?: Partial<Record<InkToolType, string>>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onClearRequest(): void;
  clearLabel?: string;
  /** 「手指书写」开关（只有正式手写与随笔提供） */
  fingerToggle?: ReactNode;
  disabled?: boolean;
  /** 「更多」菜单里排在清空之前的宿主菜单项（如草稿纸布局） */
  menuExtras?: ReactNode;
  moreLabel?: string;
  moreTitle?: string;
  /** 工具栏在所占整行里靠左还是居中 */
  align?: "start" | "center";
  /** 跟在工具栏后面的宿主按钮（如「完成标画」），不会被挤出屏幕 */
  children?: ReactNode;
}

/**
 * 宽度不够时把重做收进「更多」（与旧版工具栏的位置一致），工具区再不够就横向
 * 滑动；宽度按真实布局量，不写死断点。无布局的环境（单测）恒为宽版。
 */
function useRedoInMenu(
  rootRef: RefObject<HTMLDivElement | null>,
  stripRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [inMenu, setInMenu] = useState(false);
  const inMenuRef = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    const strip = stripRef.current;
    if (!root || !strip || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 工具区是唯一可压缩的一段：内容比可视宽度宽，就是放不下了
      const squeezed = strip.scrollWidth - strip.clientWidth > 1;
      let next = squeezed;
      if (inMenuRef.current && !squeezed) {
        let used = 0;
        for (const child of root.children) {
          used += child.getBoundingClientRect().width;
        }
        const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
        used += gap * Math.max(0, root.children.length - 1);
        next = root.clientWidth - used < REDO_SLOT_PX;
      }
      if (next === inMenuRef.current) return;
      inMenuRef.current = next;
      setInMenu(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(strip);
    measure();
    return () => observer.disconnect();
  }, [rootRef, stripRef]);
  return inMenu;
}

/** 草稿纸、正式手写、随笔与圈画共用的工具栏；只读写工具箱状态，命令由宿主转发。 */
export function InkToolbar({
  label,
  toolbox,
  onToolboxChange,
  tools = DEFAULT_TOOLS,
  toolOptions = true,
  toolLabels,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearRequest,
  clearLabel = "清空",
  fingerToggle,
  disabled = false,
  menuExtras,
  moreLabel = `更多操作（${label}）`,
  moreTitle = "更多",
  align = "start",
  children,
}: InkToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const redoInMenu = useRedoInMenu(rootRef, stripRef);
  /** 同一时刻只开一个选项面板 */
  const [openTool, setOpenTool] = useState<InkToolType | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 面板只属于「当前、可用」的那个工具：宿主换了工具或停用了工具栏就作废，
  // 之后换回来、恢复可用也不会自己弹开。
  if (openTool !== null && (disabled || toolbox.active !== openTool)) {
    setOpenTool(null);
  }
  const panelOpen = openTool !== null;

  // 在面板外按下，Popover 要等随后的 click 才收起。书写是拖动：抬笔才有
  // click，手指拖动则根本没有，面板会一直盖在纸上。所以在面板和工具栏之外
  // 按下时这里当即收起；工具栏里的按钮照旧由 Popover 和按钮自己处理。
  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (rootRef.current?.contains(target)) return;
      setOpenTool(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panelOpen]);

  const indicatorOf = (tool: InkToolType): string | null => {
    if (tool === "pen" || tool === "shape")
      return INK_PEN_COLORS[toolbox.pen.color];
    if (tool === "highlighter")
      return INK_HIGHLIGHTER_SWATCH[toolbox.highlighter.color];
    return null;
  };

  const toolButton = (tool: InkToolType) => {
    const Icon = TOOL_ICON[tool];
    const name = toolLabels?.[tool] ?? INK_TOOL_LABEL[tool];
    const active = toolbox.active === tool;
    const indicator = toolOptions ? indicatorOf(tool) : null;
    const select = () => {
      setOpenTool(null);
      onToolboxChange(selectInkTool(toolbox, tool));
    };
    const hasOptions = toolOptions && inkToolHasOptions(tool);
    const button = (
      <Button
        key={tool}
        type="button"
        variant={active ? "secondary" : "ghost"}
        className={inkToolButtonClass}
        aria-label={name}
        title={hasOptions && active ? `${name}（再点一次调整）` : name}
        aria-pressed={active}
        disabled={disabled}
        {...(hasOptions ? {} : { onClick: select })}
      >
        <Icon aria-hidden />
        {indicator !== null && (
          <span
            aria-hidden
            data-slot="ink-tool-color"
            className="absolute right-1.5 bottom-1.5 size-2 rounded-full ring-1 ring-background"
            style={{ backgroundColor: indicator }}
          />
        )}
      </Button>
    );
    if (!hasOptions) return button;
    return (
      <Popover
        key={tool}
        open={openTool === tool && active && !disabled}
        onOpenChange={(open) => setOpenTool(open ? tool : null)}
      >
        <PopoverTrigger
          asChild
          onClick={(event) => {
            // 已选中：交给 Popover 开合选项面板。未选中：只切工具，不弹面板。
            if (active) return;
            event.preventDefault();
            select();
          }}
        >
          {button}
        </PopoverTrigger>
        <PopoverContent ref={panelRef} align="start" aria-label={`${name}设置`}>
          <InkToolOptions
            tool={tool}
            toolbox={toolbox}
            onChange={onToolboxChange}
          />
        </PopoverContent>
      </Popover>
    );
  };

  const divider = (
    <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-border" />
  );

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={`${label}工具栏`}
      data-slot="ink-toolbar"
      className={cn(
        "flex w-full min-w-0 items-center gap-1",
        align === "center" ? "justify-center" : "justify-start",
      )}
    >
      <div className="flex min-h-11 min-w-0 items-center gap-0.5 rounded-xl border border-border bg-background p-1 shadow-sm">
        {/* 负外边距 + 内边距：给焦点环留出位置，不被横向滑动的裁剪边切掉 */}
        <div
          ref={stripRef}
          data-slot="ink-toolbar-tools"
          className="-m-1 flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tools.map(toolButton)}
        </div>
        {divider}
        <Button
          type="button"
          variant="ghost"
          className={inkToolButtonClass}
          aria-label="撤销"
          title="撤销"
          disabled={!canUndo || disabled}
          onClick={onUndo}
        >
          <Undo2 aria-hidden />
        </Button>
        {!redoInMenu && (
          <Button
            type="button"
            variant="ghost"
            className={inkToolButtonClass}
            aria-label="重做"
            title="重做"
            disabled={!canRedo || disabled}
            onClick={onRedo}
          >
            <Redo2 aria-hidden />
          </Button>
        )}
        {fingerToggle}
        {divider}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={inkToolButtonClass}
              aria-label={moreLabel}
              title={moreTitle}
              disabled={disabled}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
            collisionPadding={8}
          >
            {redoInMenu && (
              <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
                <Redo2 aria-hidden />
                重做
              </DropdownMenuItem>
            )}
            {menuExtras}
            {(redoInMenu || Boolean(menuExtras)) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onSelect={onClearRequest}>
              <Trash2 aria-hidden />
              {clearLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
    </div>
  );
}
