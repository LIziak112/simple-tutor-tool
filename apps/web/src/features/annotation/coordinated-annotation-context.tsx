import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  createInkToolbox,
  type InkToolboxInit,
  type InkToolboxState,
} from "@/features/ink/engine/toolbox.ts";
import { useRememberedToolbox } from "@/features/ink/toolbox-memory.ts";

/** 圈画的工具箱：缺省红色细笔（批注题面，不抢题干的黑字） */
export function createAnnotationToolbox(
  init: InkToolboxInit = {},
): InkToolboxState {
  return createInkToolbox({
    ...init,
    pen: { color: "red", size: "thin", ...init.pen },
  });
}

/**
 * 材料与原题协同标画的共享工具箱（当前工具及各工具的设置）。
 * 默认值恒为 null：消费方（如 QuestionAnnotationOverlay）必须以
 * `coordinated?.toolbox ?? 本地 state` 回退——无 Provider 的挂载语境（讲练页、
 * 单测）本地状态才真正生效，杜绝「默认值携带具体值导致回退永不命中」的
 * 静默失效。
 */
export interface CoordinatedAnnotationState {
  toolbox: InkToolboxState;
  setToolbox: (next: InkToolboxState) => void;
}

const CoordinatedAnnotationContext =
  createContext<CoordinatedAnnotationState | null>(null);

export function CoordinatedAnnotationProvider({
  children,
  initialToolbox,
}: {
  children: ReactNode;
  /** 初始工具箱，只需给出与圈画缺省不同的字段 */
  initialToolbox?: InkToolboxInit;
}) {
  // 各支工具的设置按账号记在本机（圈画单独一份，见 toolbox-memory.ts）
  const [toolbox, setToolbox] = useRememberedToolbox("annotation", () =>
    createAnnotationToolbox(initialToolbox),
  );
  const value = useMemo(() => ({ toolbox, setToolbox }), [toolbox, setToolbox]);
  return (
    <CoordinatedAnnotationContext.Provider value={value}>
      {children}
    </CoordinatedAnnotationContext.Provider>
  );
}

/** 无 Provider 时返回 null，由消费方回退到自己的本地工具箱 */
export function useCoordinatedAnnotation(): CoordinatedAnnotationState | null {
  return useContext(CoordinatedAnnotationContext);
}
