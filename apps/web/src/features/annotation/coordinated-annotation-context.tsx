import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";

export interface CoordinatedAnnotationState {
  tool: "pen" | "eraser";
  color: InkPenColor;
  size: InkPenSize;
  setTool: (tool: "pen" | "eraser") => void;
  setColor: (color: InkPenColor) => void;
  setSize: (size: InkPenSize) => void;
}

const DEFAULT_STATE: CoordinatedAnnotationState = {
  tool: "pen",
  color: "red",
  size: "thin",
  setTool: () => {},
  setColor: () => {},
  setSize: () => {},
};

const CoordinatedAnnotationContext =
  createContext<CoordinatedAnnotationState>(DEFAULT_STATE);

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

export function useCoordinatedAnnotation(): CoordinatedAnnotationState {
  return useContext(CoordinatedAnnotationContext);
}
