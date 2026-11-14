/**
 * 工具栏文案与展示色。档位的键和取值在 engine/types.ts（唯一来源），这里只放
 * 给人看的名字；色块颜色直接取引擎常量，荧光笔另给一份不透明色（半透明色放在
 * 小色块上发灰，看不出是哪一支）。
 */
import type {
  InkEraserMode,
  InkEraserSize,
  InkHighlighterColor,
  InkHighlighterSize,
  InkPenColor,
  InkPenSize,
  InkShapeKind,
  InkToolType,
} from "../engine/types.ts";

export const INK_TOOL_LABEL: Record<InkToolType, string> = {
  pen: "笔",
  highlighter: "荧光笔",
  eraser: "橡皮",
  shape: "形状",
  scroll: "滚动",
};

export const INK_PEN_COLOR_LABEL: Record<InkPenColor, string> = {
  black: "黑",
  blue: "蓝",
  red: "红",
  green: "绿",
  orange: "橙",
  purple: "紫",
};

export const INK_PEN_SIZE_LABEL: Record<InkPenSize, string> = {
  hairline: "极细",
  thin: "细",
  medium: "中",
  thick: "粗",
  heavy: "特粗",
};

export const INK_HIGHLIGHTER_COLOR_LABEL: Record<InkHighlighterColor, string> =
  {
    yellow: "黄",
    green: "绿",
    blue: "蓝",
    pink: "粉",
    orange: "橙",
  };

/** 荧光笔的不透明展示色（与 INK_HIGHLIGHTER_COLORS 同一组 RGB，单测锁定一致） */
export const INK_HIGHLIGHTER_SWATCH: Record<InkHighlighterColor, string> = {
  yellow: "rgb(250, 204, 21)",
  green: "rgb(74, 222, 128)",
  blue: "rgb(96, 165, 250)",
  pink: "rgb(244, 114, 182)",
  orange: "rgb(251, 146, 60)",
};

export const INK_HIGHLIGHTER_SIZE_LABEL: Record<InkHighlighterSize, string> = {
  thin: "细",
  medium: "中",
  thick: "粗",
};

/** 荧光笔的线条：跟着手走，还是从落笔到抬笔拉一条直线 */
export type InkHighlighterLine = "free" | "straight";

export const INK_HIGHLIGHTER_LINES: readonly InkHighlighterLine[] = [
  "free",
  "straight",
];

export const INK_HIGHLIGHTER_LINE_LABEL: Record<InkHighlighterLine, string> = {
  free: "手绘",
  straight: "直线",
};

export const INK_HIGHLIGHTER_LINE_HINT: Record<InkHighlighterLine, string> = {
  free: "跟着手的轨迹划",
  straight: "从落笔到抬笔拉一条直线，接近横平竖直时自动摆正",
};

export const INK_ERASER_MODE_LABEL: Record<InkEraserMode, string> = {
  stroke: "整笔",
  partial: "局部",
};

/** 两种擦除方式各擦掉什么：选项下面的一行说明 */
export const INK_ERASER_MODE_HINT: Record<InkEraserMode, string> = {
  stroke: "碰到哪一笔，就擦掉那一整笔",
  partial: "只擦掉橡皮碰到的那一段",
};

export const INK_ERASER_SIZE_LABEL: Record<InkEraserSize, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

export const INK_SHAPE_LABEL: Record<InkShapeKind, string> = {
  line: "直线",
  arrow: "箭头",
  rect: "矩形",
  ellipse: "椭圆",
};

/** 每种形状怎么画：选项下面的一行说明（形状选项只有图标，这里带上名字） */
export const INK_SHAPE_HINT: Record<InkShapeKind, string> = {
  line: "直线：从一头拖到另一头，接近横平竖直时自动摆正",
  arrow: "箭头：从箭尾拖到箭尖，接近横平竖直时自动摆正",
  rect: "矩形：从一个角拖到对角",
  ellipse: "椭圆：从一个角拖到对角，画出框里的椭圆",
};
