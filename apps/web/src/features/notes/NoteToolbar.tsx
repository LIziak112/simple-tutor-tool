import type { ComponentProps } from "react";
import { CompactInkToolbar } from "@/features/ink/CompactInkToolbar";

type PenTool = "pen" | "eraser";
type NoteToolbarProps = Omit<
  ComponentProps<typeof CompactInkToolbar>,
  "tool" | "onToolChange" | "advanced"
> & {
  tool: PenTool;
  onToolChange(tool: PenTool): void;
};

/** 纸面和圈画只开放笔、橡皮；工具栏的呈现与菜单共用。 */
export function NoteToolbar({
  onToolChange,
  compact = false,
  moreTitle = "更多（重做/颜色/粗细/清空）",
  ...props
}: NoteToolbarProps) {
  return (
    <CompactInkToolbar
      {...props}
      compact={compact}
      moreTitle={moreTitle}
      onToolChange={(tool) => {
        if (tool === "pen" || tool === "eraser") onToolChange(tool);
      }}
    />
  );
}
