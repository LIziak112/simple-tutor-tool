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

/** 草稿和正式手写共享工具呈现，命令仍由各自控制器处理。 */
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
  fingerToggle: ReactNode;
  advanced?: boolean;
  disabled?: boolean;
  clearLabel?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={`${label}工具栏`}
      className="flex min-h-11 min-w-0 items-center gap-1"
    >
      <a
        href="/s/settings/ink-feel"
        className="inline-flex min-h-11 items-center px-2 text-xs text-primary"
      >
        手感设置
      </a>
      <Button
        variant={tool === "pen" ? "secondary" : "ghost"}
        className="size-11 shrink-0 p-0"
        aria-label="笔"
        title="笔"
        aria-pressed={tool === "pen"}
        disabled={disabled}
        onClick={() => onToolChange("pen")}
      >
        <PenLine aria-hidden />
      </Button>
      <Button
        variant={tool === "eraser" ? "secondary" : "ghost"}
        className="size-11 shrink-0 p-0"
        aria-label="橡皮"
        title="橡皮"
        aria-pressed={tool === "eraser"}
        disabled={disabled}
        onClick={() => onToolChange("eraser")}
      >
        <Eraser aria-hidden />
      </Button>
      <Button
        variant="ghost"
        className="size-11 shrink-0 p-0"
        aria-label="撤销"
        title="撤销"
        disabled={!canUndo || disabled}
        onClick={onUndo}
      >
        <Undo2 aria-hidden />
      </Button>
      {fingerToggle}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex size-11 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`更多操作（${label}）`}
          title="更多"
          disabled={disabled}
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
              颜色：{{ black: "黑", blue: "蓝", red: "红" }[value]}
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
              粗细：{{ thin: "细", medium: "中", thick: "粗" }[value]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onClearRequest}>
            {clearLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
