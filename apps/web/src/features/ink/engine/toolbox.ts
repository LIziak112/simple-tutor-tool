/**
 * 工具箱状态：工具栏与书写面之间的单一事实来源。
 *
 * 工具栏只读写这一份纯数据；宿主（草稿纸、正式手写、随笔、圈画）把
 * toolConfigOf(toolbox) 下发给书写面的 setTool。每种工具各自记住自己的设置，
 * 切走再切回不丢；形状工具与笔共用颜色、粗细。
 */
import {
  INK_ERASER_SIZES,
  INK_HIGHLIGHTER_COLORS,
  INK_HIGHLIGHTER_SIZES,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
  type InkEraserMode,
  type InkEraserSize,
  type InkHighlighterColor,
  type InkHighlighterSize,
  type InkPenColor,
  type InkPenSize,
  type InkShapeKind,
  type InkToolConfig,
  type InkToolType,
} from "./types.ts";

export interface InkToolboxState {
  /** 当前工具 */
  active: InkToolType;
  pen: { color: InkPenColor; size: InkPenSize };
  highlighter: {
    color: InkHighlighterColor;
    size: InkHighlighterSize;
    straight: boolean;
  };
  eraser: { mode: InkEraserMode; size: InkEraserSize };
  shape: { kind: InkShapeKind };
}

/** 创建工具箱时可只给部分字段，其余取缺省值 */
export interface InkToolboxInit {
  active?: InkToolType;
  pen?: Partial<InkToolboxState["pen"]>;
  highlighter?: Partial<InkToolboxState["highlighter"]>;
  eraser?: Partial<InkToolboxState["eraser"]>;
  shape?: Partial<InkToolboxState["shape"]>;
}

export const DEFAULT_INK_TOOLBOX: InkToolboxState = {
  active: "pen",
  pen: { color: "black", size: "medium" },
  highlighter: { color: "yellow", size: "medium", straight: false },
  eraser: { mode: "stroke", size: "medium" },
  shape: { kind: "line" },
};

export const INK_TOOL_TYPES: readonly InkToolType[] = [
  "pen",
  "highlighter",
  "eraser",
  "shape",
  "scroll",
];
export const INK_ERASER_MODES: readonly InkEraserMode[] = ["stroke", "partial"];
export const INK_SHAPE_KINDS: readonly InkShapeKind[] = [
  "line",
  "arrow",
  "rect",
  "ellipse",
];

/** 档位表的键（按声明顺序），工具栏据此逐项渲染 */
function keysOf<K extends string>(record: Record<K, unknown>): readonly K[] {
  return Object.keys(record) as K[];
}
export const INK_PEN_COLOR_KEYS = keysOf(INK_PEN_COLORS);
export const INK_PEN_SIZE_KEYS = keysOf(INK_PEN_SIZES);
export const INK_HIGHLIGHTER_COLOR_KEYS = keysOf(INK_HIGHLIGHTER_COLORS);
export const INK_HIGHLIGHTER_SIZE_KEYS = keysOf(INK_HIGHLIGHTER_SIZES);
export const INK_ERASER_SIZE_KEYS = keysOf(INK_ERASER_SIZES);

export function createInkToolbox(init: InkToolboxInit = {}): InkToolboxState {
  return {
    active: init.active ?? DEFAULT_INK_TOOLBOX.active,
    pen: { ...DEFAULT_INK_TOOLBOX.pen, ...init.pen },
    highlighter: { ...DEFAULT_INK_TOOLBOX.highlighter, ...init.highlighter },
    eraser: { ...DEFAULT_INK_TOOLBOX.eraser, ...init.eraser },
    shape: { ...DEFAULT_INK_TOOLBOX.shape, ...init.shape },
  };
}

/** 切换当前工具；已是该工具时返回原对象（调用方可据此跳过无效更新） */
export function selectInkTool(
  toolbox: InkToolboxState,
  tool: InkToolType,
): InkToolboxState {
  return toolbox.active === tool ? toolbox : { ...toolbox, active: tool };
}

/** 工具箱 → 下发给书写面的完整工具配置 */
export function toolConfigOf(toolbox: InkToolboxState): InkToolConfig {
  switch (toolbox.active) {
    case "pen":
      return { type: "pen", ...toolbox.pen };
    case "highlighter":
      return { type: "highlighter", ...toolbox.highlighter };
    case "eraser":
      return { type: "eraser", ...toolbox.eraser };
    case "shape":
      return { type: "shape", shape: toolbox.shape.kind, ...toolbox.pen };
    case "scroll":
      return { type: "scroll" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 值是否为 record 自身的键（不认原型链上的 toString 等） */
function keyOf<K extends string>(
  record: Record<K, unknown>,
  value: unknown,
): value is K {
  return typeof value === "string" && Object.hasOwn(record, value);
}

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

/**
 * 读回持久化的工具箱：逐字段校验，非法字段回退 fallback 的对应值；allowed
 * 给出时，当前工具不在其中则回退 fallback.active（宿主不提供该工具）。
 */
export function parseInkToolbox(
  raw: unknown,
  fallback: InkToolboxState,
  allowed: readonly InkToolType[] = INK_TOOL_TYPES,
): InkToolboxState {
  const root = isRecord(raw) ? raw : {};
  const pen = isRecord(root.pen) ? root.pen : {};
  const highlighter = isRecord(root.highlighter) ? root.highlighter : {};
  const eraser = isRecord(root.eraser) ? root.eraser : {};
  const shape = isRecord(root.shape) ? root.shape : {};
  return {
    active: oneOf(allowed, root.active) ? root.active : fallback.active,
    pen: {
      color: keyOf(INK_PEN_COLORS, pen.color) ? pen.color : fallback.pen.color,
      size: keyOf(INK_PEN_SIZES, pen.size) ? pen.size : fallback.pen.size,
    },
    highlighter: {
      color: keyOf(INK_HIGHLIGHTER_COLORS, highlighter.color)
        ? highlighter.color
        : fallback.highlighter.color,
      size: keyOf(INK_HIGHLIGHTER_SIZES, highlighter.size)
        ? highlighter.size
        : fallback.highlighter.size,
      straight:
        typeof highlighter.straight === "boolean"
          ? highlighter.straight
          : fallback.highlighter.straight,
    },
    eraser: {
      mode: oneOf(INK_ERASER_MODES, eraser.mode)
        ? eraser.mode
        : fallback.eraser.mode,
      size: keyOf(INK_ERASER_SIZES, eraser.size)
        ? eraser.size
        : fallback.eraser.size,
    },
    shape: {
      kind: oneOf(INK_SHAPE_KINDS, shape.kind)
        ? shape.kind
        : fallback.shape.kind,
    },
  };
}
