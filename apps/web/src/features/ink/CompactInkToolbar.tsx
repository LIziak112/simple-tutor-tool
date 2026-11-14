import {
  Eraser,
  Highlighter,
  MoreHorizontal,
  PenLine,
  Redo2,
  Trash2,
  Undo2,
  MousePointer2
} from "lucide-react";
import type { ReactNode } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
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

  const renderPenOptions = (isHighlighter = false) => (
    <div className="p-2 flex flex-col gap-3 min-w-32 outline-none">
      <DropdownMenuPrimitive.RadioGroup
        value={color}
        onValueChange={(val: string) => {
          onColorChange(val as InkPenColor);
          onToolChange(isHighlighter ? "highlighter" : "pen");
        }}
        className="flex items-center gap-2 outline-none"
        aria-label="颜色"
      >
        {(["black", "blue", "red"] as const).map((c) => (
          <DropdownMenuPrimitive.RadioItem
            key={c}
            value={c}
            aria-label={COLOR_LABEL[c]}
            title={COLOR_LABEL[c]}
            className={`w-8 h-8 rounded-full border-2 ${color === c ? "border-primary scale-110" : "border-transparent"} transition-transform hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
            style={{ backgroundColor: c === "black" ? "#222" : c === "blue" ? "#3b82f6" : "#ef4444" }}
          />
        ))}
      </DropdownMenuPrimitive.RadioGroup>
      <DropdownMenuPrimitive.RadioGroup
        value={size}
        onValueChange={(val: string) => {
          onSizeChange(val as InkPenSize);
          onToolChange(isHighlighter ? "highlighter" : "pen");
        }}
        className="flex items-center justify-between gap-1 mt-1 outline-none"
        aria-label="粗细"
      >
        {(["thin", "medium", "thick"] as const).map((s) => (
          <DropdownMenuPrimitive.RadioItem
            key={s}
            value={s}
            aria-label={SIZE_LABEL[s]}
            title={SIZE_LABEL[s]}
            className={`flex-1 h-8 rounded border flex items-center justify-center ${size === s ? "bg-accent border-primary" : "border-border hover:bg-accent/50"} transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
          >
            <div 
              className="bg-foreground rounded-full" 
              style={{ 
                width: s === "thin" ? "4px" : s === "medium" ? "8px" : "12px",
                height: s === "thin" ? "4px" : s === "medium" ? "8px" : "12px" 
              }} 
            />
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuPrimitive.RadioGroup>
    </div>
  );

  return (
    <div
      role="toolbar"
      aria-label={`${label}工具栏`}
      className={
        compact
          ? "flex min-h-11 min-w-0 items-center gap-1 rounded-xl bg-background border shadow-sm p-1"
          : "flex flex-wrap items-center gap-1.5 rounded-xl bg-background border shadow-sm p-1.5"
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={tool === "pen" ? "secondary" : "ghost"}
            className={buttonClass}
            aria-label="笔"
            title="笔"
            aria-pressed={tool === "pen"}
            disabled={disabled}
            onPointerDown={(e) => {
              // Only left click
              if (e.button !== 0 || e.ctrlKey) return;
              if (tool !== "pen") {
                e.preventDefault();
                onToolChange("pen");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                if (tool !== "pen") {
                  e.preventDefault();
                  onToolChange("pen");
                }
              }
            }}
            onClick={(e) => {
              if (tool !== "pen") {
                e.preventDefault();
                onToolChange("pen");
              }
            }}
          >
            <PenLine aria-hidden />
            {!compact && "笔"}
            {tool === "pen" && (
              <span 
                className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border border-background" 
                style={{ backgroundColor: color === "black" ? "#222" : color === "blue" ? "#3b82f6" : "#ef4444" }} 
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" sideOffset={8}>
          {renderPenOptions(false)}
        </DropdownMenuContent>
      </DropdownMenu>

      {advanced && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={tool === "highlighter" ? "secondary" : "ghost"}
              className={buttonClass}
              aria-label="荧光笔"
              title="荧光笔"
              aria-pressed={tool === "highlighter"}
              disabled={disabled}
              onPointerDown={(e) => {
                // Only left click
                if (e.button !== 0 || e.ctrlKey) return;
                if (tool !== "highlighter") {
                  e.preventDefault();
                  onToolChange("highlighter");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  if (tool !== "highlighter") {
                    e.preventDefault();
                    onToolChange("highlighter");
                  }
                }
              }}
              onClick={(e) => {
                if (tool !== "highlighter") {
                  e.preventDefault();
                  onToolChange("highlighter");
                }
              }}
            >
              <Highlighter aria-hidden />
              {!compact && "荧光笔"}
              {tool === "highlighter" && (
                <span 
                  className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border border-background opacity-50" 
                  style={{ backgroundColor: color === "black" ? "#222" : color === "blue" ? "#3b82f6" : "#ef4444" }} 
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" sideOffset={8}>
            {renderPenOptions(true)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

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
      
      {advanced && (
         <Button
         variant={tool === "scroll" ? "secondary" : "ghost"}
         className={buttonClass}
         aria-label="滚动/选择"
         title="滚动/选择"
         aria-pressed={tool === "scroll"}
         disabled={disabled}
         onClick={() => onToolChange("scroll")}
       >
         <MousePointer2 aria-hidden />
         {!compact && "滚动"}
       </Button>
      )}

      <div className="w-px h-6 bg-border mx-1" />

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
      
      <Button
        variant="ghost"
        className={buttonClass}
        aria-label="重做"
        title="重做"
        disabled={!canRedo || disabled}
        onClick={onRedo}
      >
        <Redo2 aria-hidden />
        {!compact && "重做"}
      </Button>

      {fingerToggle}
      
      {menuExtras || onClearRequest ? (
        <>
          <div className="w-px h-6 bg-border mx-1" />
          <DropdownMenu>
            <DropdownMenuTrigger
              className={`flex shrink-0 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground transition-colors ${compact ? "size-11 rounded-md" : `ml-auto ${toolButtonClass}`}`}
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
              {menuExtras}
              {menuExtras && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" onSelect={onClearRequest} className="text-destructive focus:text-destructive focus:bg-destructive/10">
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                {clearLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      {children}
    </div>
  );
}
