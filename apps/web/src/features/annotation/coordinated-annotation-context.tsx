import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";

/**
 * 材料与原题协同标画的共享笔态（笔/橡皮、颜色、粗细）。
 * 默认值恒为 null：消费方（如 QuestionAnnotationOverlay）必须以
 * `coordinated?.tool ?? 本地 state` 回退——无 Provider 的挂载语境（讲练页、
 * 单测）本地状态才真正生效，杜绝「默认值携带具体值导致回退永不命中」的
 * 静默失效。
 */
export interface CoordinatedAnnotationState {
  tool: "pen" | "eraser";
  color: InkPenColor;
  size: InkPenSize;
  setTool: (tool: "pen" | "eraser") => void;
  setColor: (color: InkPenColor) => void;
  setSize: (size: InkPenSize) => void;
}

const CoordinatedAnnotationContext =
  createContext<CoordinatedAnnotationState | null>(null);

export function CoordinatedAnnotationProvider({
  children,
  initialTool = "pen",
  initialColor = "red",
  initialSize = "thin",
}: {
  children: ReactNode;
  initialTool?: "pen" | "eraser";
  initialColor?: InkPenColor;
  initialSize?: InkPenSize;
}) {
  const [tool, setTool] = useState<"pen" | "eraser">(initialTool);
  const [color, setColor] = useState<InkPenColor>(initialColor);
  const [size, setSize] = useState<InkPenSize>(initialSize);

  const value = useMemo(
    () => ({
      tool,
      color,
      size,
      setTool,
      setColor,
      setSize,
    }),
    [tool, color, size],
  );

  return (
    <CoordinatedAnnotationContext.Provider value={value}>
      {children}
    </CoordinatedAnnotationContext.Provider>
  );
}

/** 无 Provider 时返回 null，由消费方回退到自己的本地笔态 */
export function useCoordinatedAnnotation(): CoordinatedAnnotationState | null {
  return useContext(CoordinatedAnnotationContext);
}
