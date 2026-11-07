import type { NoteBackground, QuestionProcessFinish } from "@tutor/contract";
import { type ReactNode, useEffect, useState } from "react";
import { NoteToolbar } from "@/features/notes/NoteToolbar";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkPenColor,
  InkPenSize,
} from "./engine";
import { InkPad, SessionPrefToggleButton } from "./InkPad";
import { useInkProfileSelection } from "./ink-profile-store";

/** 草稿与正式作答共用纸面和工具栏，正文由调用方各自保存。 */
export function PaperEditor({
  label,
  initial,
  engineRef,
  onDocChange,
  inputEnabled,
  paperHeight,
  background = "grid",
  compact = true,
  clearLabel,
  menuExtras,
  onClearRequest,
  onEngineRebuild,
  maxDeletedPoints,
  showToolbar = true,
  mountPad = true,
  initialHeight,
  moreTitle = "更多（重做/颜色/粗细/清空）",
  allowFingerWriting = false,
}: {
  label: string;
  initial?: InkDoc | undefined;
  engineRef: React.RefObject<InkEngine | null>;
  onDocChange: (
    doc: InkDoc,
    reason: InkChangeReason,
    finish?: QuestionProcessFinish,
  ) => void;
  inputEnabled: boolean;
  paperHeight?: number | undefined;
  background?: NoteBackground;
  compact?: boolean;
  clearLabel: string;
  menuExtras?: ReactNode;
  onClearRequest(): void;
  onEngineRebuild?: (() => void) | undefined;
  maxDeletedPoints?: number | undefined;
  showToolbar?: boolean;
  mountPad?: boolean;
  initialHeight?: number | undefined;
  moreTitle?: string;
  allowFingerWriting?: boolean;
}) {
  const profile = useInkProfileSelection();
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState<InkPenColor>(profile.config.color);
  const [size, setSize] = useState<InkPenSize>(profile.config.size);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    setColor(profile.config.color);
    setSize(profile.config.size);
  }, [profile.config]);
  // 引擎重建或纸面重新启用后重新下发当前工具。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 重建与启用是必要的触发器
  useEffect(() => {
    engineRef.current?.setTool(
      tool === "pen" ? { type: "pen", color, size } : { type: "eraser" },
    );
    setHistory({
      undo: engineRef.current?.canUndo() ?? false,
      redo: engineRef.current?.canRedo() ?? false,
    });
  }, [tool, color, size, engineRef, generation, inputEnabled]);
  return (
    <div data-slot="paper-editor" className="flex min-w-0 flex-col gap-2">
      {showToolbar && (
        <div inert={!inputEnabled}>
          <NoteToolbar
            compact={compact}
            label={label}
            tool={tool}
            onToolChange={setTool}
            color={color}
            onColorChange={setColor}
            size={size}
            onSizeChange={setSize}
            canUndo={history.undo}
            canRedo={history.redo}
            onUndo={() => engineRef.current?.undo()}
            onRedo={() => engineRef.current?.redo()}
            onClearRequest={onClearRequest}
            clearLabel={clearLabel}
            moreTitle={moreTitle}
            menuExtras={menuExtras}
            fingerToggle={
              allowFingerWriting && (
                <SessionPrefToggleButton
                  iconOnly={compact}
                  {...(compact ? { className: "size-11 shrink-0 p-0" } : {})}
                />
              )
            }
          />
        </div>
      )}
      {mountPad && (
        <InkPad
          engine="atrament"
          showToolbar={false}
          inputMode={allowFingerWriting ? "session" : "pen"}
          label={label}
          initial={initial}
          engineRef={engineRef}
          inputEnabled={inputEnabled}
          background={background}
          {...(initialHeight === undefined ? {} : { initialHeight })}
          {...(paperHeight === undefined ? {} : { paperHeight })}
          {...(maxDeletedPoints === undefined ? {} : { maxDeletedPoints })}
          onEngineRebuild={() => {
            setGeneration((value) => value + 1);
            onEngineRebuild?.();
          }}
          onDocChange={(doc, reason, finish) => {
            onDocChange(doc, reason, finish);
            setHistory({
              undo: engineRef.current?.canUndo() ?? false,
              redo: engineRef.current?.canRedo() ?? false,
            });
          }}
        />
      )}
    </div>
  );
}
