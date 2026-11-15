/**
 * 工具栏和选项面板里自己画的小图形（图标库里没有合适的）。都只是装饰：
 * 名字由所在的按钮、选项提供给读屏。
 */
import { cn } from "cn";
import type { InkEraserMode, InkShapeKind } from "../engine/types.ts";
import type { InkHighlighterLine } from "./tool-labels.ts";

/**
 * 形状工具的图形：直线、箭头、矩形、椭圆各一个，线条规格与图标库一致
 * （24 格、线宽 2、圆头）。工具栏上形状按钮的图标也用它——当前选的是哪种
 * 形状，不用点开面板就看得到。不给 className 时大小由所在按钮决定。
 */
export function InkShapeGlyph({
  kind,
  className,
}: {
  kind: InkShapeKind;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      data-slot="ink-shape-glyph"
      data-shape={kind}
      viewBox="0 0 24 24"
      className={cn("shrink-0 fill-none stroke-current", className)}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "line" && <path d="M5 19 19 5" />}
      {kind === "arrow" && <path d="M5 19 19 5M9 5h10v10" />}
      {kind === "rect" && <rect x="3" y="6" width="18" height="12" rx="1" />}
      {kind === "ellipse" && <ellipse cx="12" cy="12" rx="9.5" ry="6.5" />}
    </svg>
  );
}

/**
 * 擦除方式的图形：一笔波浪线。整笔——整条都擦成了虚线；局部——只有中间断开
 * 一截，两头还是实线。
 */
export function EraserModeGlyph({ mode }: { mode: InkEraserMode }) {
  const wave = "M3 13 C 7 3, 11 3, 14 10 S 21 17, 25 7";
  return (
    <svg
      aria-hidden
      viewBox="0 0 28 20"
      className="h-5 w-7 shrink-0 fill-none stroke-foreground"
      strokeWidth={2}
      strokeLinecap="round"
    >
      {mode === "stroke" ? (
        <path d={wave} strokeDasharray="1.5 3.5" className="opacity-50" />
      ) : (
        <path d={wave} pathLength={100} strokeDasharray="36 28 36" />
      )}
    </svg>
  );
}

/** 荧光笔线条的图形：手绘是一道起伏的粗线，直线是一道平直的粗线 */
export function HighlighterLineGlyph({
  line,
  color,
}: {
  line: InkHighlighterLine;
  /** 荧光笔当前的展示色 */
  color: string;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 28 20"
      className="h-5 w-7 shrink-0 fill-none"
      stroke={color}
      strokeWidth={6}
      strokeLinecap="round"
    >
      <path
        d={
          line === "free"
            ? "M4 12 C 9 4, 13 6, 15 10 S 21 15, 24 8"
            : "M4 10H24"
        }
      />
    </svg>
  );
}
