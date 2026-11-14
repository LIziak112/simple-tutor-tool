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

export const INK_ERASER_MODE_LABEL: Record<InkEraserMode, string> = {
  stroke: "整笔",
  partial: "局部",
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
