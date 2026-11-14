import type { NoteBackground, QuestionProcessFinish } from "@tutor/contract";
import { type ReactNode, useEffect, useState } from "react";
import type { InkChangeReason, InkDoc, InkEngine } from "./engine";
import { createInkToolbox, toolConfigOf } from "./engine/toolbox.ts";
import { InkPad, SessionPrefToggleButton } from "./InkPad";
import { useInkProfileSelection } from "./ink-profile-store";
import { InkToolbar } from "./toolbar/InkToolbar.tsx";

/** 草稿与正式作答共用纸面和工具栏，正文由调用方各自保存。 */
export function PaperEditor({
  label,
  initial,
  engineRef,
  onDocChange,
  inputEnabled,
  paperHeight,
  background = "grid",
  clearLabel,
  menuExtras,
  onClearRequest,
  onEngineRebuild,
  maxDeletedPoints,
  showToolbar = true,
  mountPad = true,
  initialHeight,
  moreTitle = "更多（清空）",
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
  /** 工具箱：笔的颜色、粗细跟随笔感设置，设置变化时重新取值 */
  const [toolbox, setToolbox] = useState(() =>
    createInkToolbox({
      pen: { color: profile.config.color, size: profile.config.size },
    }),
  );
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const { color, size } = profile.config;
    setToolbox((current) =>
      current.pen.color === color && current.pen.size === size
        ? current
        : { ...current, pen: { color, size } },
    );
  }, [profile.config]);
  // 引擎重建或纸面重新启用后重新下发当前工具。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 重建与启用是必要的触发器
  useEffect(() => {
    engineRef.current?.setTool(toolConfigOf(toolbox));
    setHistory({
      undo: engineRef.current?.canUndo() ?? false,
      redo: engineRef.current?.canRedo() ?? false,
    });
  }, [toolbox, engineRef, generation, inputEnabled]);
  return (
    <div data-slot="paper-editor" className="flex min-w-0 flex-col gap-2">
      {showToolbar && (
        <div inert={!inputEnabled}>
          <InkToolbar
            label={label}
            toolbox={toolbox}
            onToolboxChange={setToolbox}
            canUndo={history.undo}
            canRedo={history.redo}
            onUndo={() => engineRef.current?.undo()}
            onRedo={() => engineRef.current?.redo()}
            onClearRequest={onClearRequest}
            clearLabel={clearLabel}
            moreTitle={moreTitle}
            menuExtras={menuExtras}
            fingerToggle={allowFingerWriting && <SessionPrefToggleButton />}
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
