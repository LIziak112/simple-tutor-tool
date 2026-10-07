/**
 * 草稿/订正编辑器的共享精简工具条（T6R.15 单3 从 NoteLayer 抽出）：笔/橡皮/
 * 撤销/手指书写/更多（重做/颜色/粗细/清空 + 场景特有菜单段）。NoteLayer（答题
 * 页草稿纸）与 CorrectionPanel（订正编辑器）共用——「手指书写」按钮经
 * InkPad.SessionPrefToggleButton 共用会话偏好 store（T6R.7 衔接注记①定案：
 * 按钮归属编辑器工具条，多画布共享同一状态，不另建）。
 * 触控目标 ≥44px（ui-conventions 硬性要求；toolButtonClass 同 InkPad 口径）。
 */

import {
  Check,
  Eraser,
  MoreHorizontal,
  PenLine,
  Redo2,
  Trash,
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
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index.ts";
import {
  COLOR_LABEL,
  SessionPrefToggleButton,
  SIZE_LABEL,
  toolButtonClass,
} from "@/features/ink/InkPad";

export interface NoteToolbarProps {
  /** 无障碍标签前缀（拼「工具栏」） */
  label: string;
  tool: "pen" | "eraser";
  onToolChange: (tool: "pen" | "eraser") => void;
  penColor: InkPenColor;
  onPenColorChange: (color: InkPenColor) => void;
  penSize: InkPenSize;
  onPenSizeChange: (size: InkPenSize) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 请求清空（打开调用方的二次确认弹层；清空=空稿版本上传的覆盖语义） */
  onClearRequest: () => void;
  /** 清空菜单项文案（NoteLayer「清空草稿纸」/ CorrectionPanel「清空订正」） */
  clearLabel?: string;
  /** 「更多」菜单的追加段（场景特有——NoteLayer 的布局 preference 等）；
   * 渲染在清空项之前，自带分隔条 */
  menuExtras?: ReactNode;
}

export function NoteToolbar({
  label,
  tool,
  onToolChange,
  penColor,
  onPenColorChange,
  penSize,
  onPenSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearRequest,
  clearLabel = "清空",
  menuExtras,
}: NoteToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={`${label}工具栏`}
      className="flex flex-wrap items-center gap-1.5"
    >
      <Button
        type="button"
        variant={tool === "pen" ? "secondary" : "ghost"}
        aria-pressed={tool === "pen"}
        onClick={() => onToolChange("pen")}
        className={toolButtonClass}
        title="笔"
      >
        <PenLine aria-hidden />笔
      </Button>
      <Button
        type="button"
        variant={tool === "eraser" ? "secondary" : "ghost"}
        aria-pressed={tool === "eraser"}
        onClick={() => onToolChange("eraser")}
        className={toolButtonClass}
        title="橡皮（整笔擦除）"
      >
        <Eraser aria-hidden />
        橡皮
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={!canUndo}
        onClick={onUndo}
        className={toolButtonClass}
        title="撤销"
      >
        <Undo2 aria-hidden />
        撤销
      </Button>
      {/* 手指书写（注记①定案：归属编辑器工具条，一次点击可达；共用件） */}
      <SessionPrefToggleButton className={toolButtonClass} />

      <div className="ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            aria-label={`更多操作（${label}）`}
            title="更多（重做/颜色/粗细/清空）"
            className={`${toolButtonClass} border-transparent`}
          >
            <MoreHorizontal aria-hidden />
            更多
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
              <Redo2 aria-hidden />
              重做
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {(Object.keys(COLOR_LABEL) as InkPenColor[]).map((c) => (
              <DropdownMenuItem
                key={c}
                aria-checked={penColor === c}
                onSelect={() => {
                  onPenColorChange(c);
                  onToolChange("pen");
                }}
              >
                <Check
                  aria-hidden
                  className={penColor === c ? "visible" : "invisible"}
                />
                颜色：{COLOR_LABEL[c]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {(Object.keys(SIZE_LABEL) as InkPenSize[]).map((s) => (
              <DropdownMenuItem
                key={s}
                aria-checked={penSize === s}
                onSelect={() => {
                  onPenSizeChange(s);
                  onToolChange("pen");
                }}
              >
                <Check
                  aria-hidden
                  className={penSize === s ? "visible" : "invisible"}
                />
                粗细：{SIZE_LABEL[s]}
              </DropdownMenuItem>
            ))}
            {menuExtras !== undefined && (
              <>
                <DropdownMenuSeparator />
                {menuExtras}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClearRequest}>
              <Trash aria-hidden />
              {clearLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
