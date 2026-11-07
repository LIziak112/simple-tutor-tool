import {
  Eraser,
  Highlighter,
  MoreHorizontal,
  PenLine,
  Redo2,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InkPenColor, InkPenSize, InkToolType } from "./engine/index";

export const toolButtonClass =
  "h-11 min-w-11 px-2.5 gap-1.5 rounded-lg border border-border text-sm font-medium select-none transition-colors";

export const COLOR_LABEL = { black: "黑", blue: "蓝", red: "红" } as const;
export const SIZE_LABEL = { thin: "细", medium: "中", thick: "粗" } as const;

/** 圈画、草稿与正式手写共享工具呈现，命令仍由各自控制器处理。 */
export function CompactInkToolbar({
  label,
  tool,
  onToolChange,
  color,
  onColorChange,
  size,
  onSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearRequest,
  fingerToggle,
  advanced = false,
  disabled = false,
  clearLabel = "清空",
  menuExtras,
  compact = true,
  moreLabel = `更多操作（${label}）`,
  moreTitle = "更多",
  children,
}: {
  label: string;
  tool: InkToolType;
  onToolChange(tool: InkToolType): void;
  color: InkPenColor;
  onColorChange(color: InkPenColor): void;
  size: InkPenSize;
  onSizeChange(size: InkPenSize): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onClearRequest(): void;
  fingerToggle?: ReactNode;
  advanced?: boolean;
  disabled?: boolean;
  clearLabel?: string;
  menuExtras?: ReactNode;
  compact?: boolean;
  moreLabel?: string;
  moreTitle?: string;
  children?: ReactNode;
}) {
  const buttonClass = compact ? "size-11 shrink-0 p-0" : toolButtonClass;
  return (
    <div
      role="toolbar"
      aria-label={`${label}工具栏`}
      className={
        compact
          ? "flex min-h-11 min-w-0 items-center gap-1"
          : "flex flex-wrap items-center gap-1.5"
      }
    >
      <Button
        variant={tool === "pen" ? "secondary" : "ghost"}
        className={buttonClass}
        aria-label="笔"
        title="笔"
        aria-pressed={tool === "pen"}
        disabled={disabled}
        onClick={() => onToolChange("pen")}
      >
        <PenLine aria-hidden />
        {!compact && "笔"}
      </Button>
      <Button
        variant={tool === "eraser" ? "secondary" : "ghost"}
        className={buttonClass}
        aria-label="橡皮"
        title="橡皮"
        aria-pressed={tool === "eraser"}
        disabled={disabled}
        onClick={() => onToolChange("eraser")}
      >
        <Eraser aria-hidden />
        {!compact && "橡皮"}
      </Button>
      <Button
        variant="ghost"
        className={buttonClass}
        aria-label="撤销"
        title="撤销"
        disabled={!canUndo || disabled}
        onClick={onUndo}
      >
        <Undo2 aria-hidden />
        {!compact && "撤销"}
      </Button>
      {fingerToggle}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={`flex shrink-0 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "size-11 rounded-md" : `ml-auto border-transparent ${toolButtonClass}`}`}
          aria-label={moreLabel}
          title={moreTitle}
          disabled={disabled}
        >
          <MoreHorizontal aria-hidden />
          {!compact && "更多"}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
          collisionPadding={8}
        >
          <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
            <Redo2 aria-hidden />
            重做
          </DropdownMenuItem>
          {advanced && (
            <>
              <DropdownMenuItem onSelect={() => onToolChange("highlighter")}>
                <Highlighter aria-hidden />
                荧光笔
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onToolChange("scroll")}>
                滚动模式
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          {(["black", "blue", "red"] as const).map((value) => (
            <DropdownMenuItem
              key={value}
              role="menuitemradio"
              aria-checked={color === value}
              onSelect={() => {
                onColorChange(value);
                onToolChange("pen");
              }}
            >
              <span
                aria-hidden
                className="size-3 rounded-full"
                style={{ backgroundColor: value }}
              />
              颜色：{COLOR_LABEL[value]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {(["thin", "medium", "thick"] as const).map((value) => (
            <DropdownMenuItem
              key={value}
              role="menuitemradio"
              aria-checked={size === value}
              onSelect={() => {
                onSizeChange(value);
                onToolChange("pen");
              }}
            >
              粗细：{SIZE_LABEL[value]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {menuExtras}
          {menuExtras && <DropdownMenuSeparator />}
          <DropdownMenuItem variant="destructive" onSelect={onClearRequest}>
            {clearLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {children}
    </div>
  );
}
