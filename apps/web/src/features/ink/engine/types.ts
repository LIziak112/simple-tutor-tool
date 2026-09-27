/**
 * 手写引擎数据结构（T2.7，架构 §5.4 数据层）。
 *
 * 核心约定：
 * - 矢量坐标一律**归一化到逻辑宽度 1000**（INK_LOGICAL_WIDTH）——横竖屏旋转、
 *   换设备都能无损重绘；
 * - 状态与历史（撤销/重做/变更通知）放纯数据层（history.ts），不碰 DOM/canvas，
 *   可完整单测；适配器层保持薄；
 * - 数据库与文件只存 InkDoc（库自己的 JSON 格式 + engine 字段），消费方只依赖
 *   InkSurface 接口（surface.ts），不直接 import 绘制库。
 */

/** 归一化逻辑宽度：所有 x/y/weight 以"画布宽度 = 1000"为基准存储 */
export const INK_LOGICAL_WIDTH = 1000;

/** 底层绘制引擎（InkSurface 适配层后面的实现） */
export type InkEngineKind = "atrament" | "excalidraw";

/** 工具类型：笔 / 荧光笔 / 整笔橡皮 / 滚动模式（无笔设备的回退开关，§5.4.1 输入层第 3 条） */
export type InkToolType = "pen" | "highlighter" | "eraser" | "scroll";

/** 笔粗细档位（§5.4.1 绘制层第 3 条：笔 2–3 档粗细） */
export type InkPenSize = "thin" | "medium" | "thick";

/** 笔颜色（§5.4.1 绘制层第 3 条：黑/蓝/红） */
export type InkPenColor = "black" | "blue" | "red";

/** setTool 参数：可选属性缺省表示沿用上一次的设置 */
export type InkToolConfig =
  | { type: "pen"; color?: InkPenColor; size?: InkPenSize }
  | { type: "highlighter" }
  | { type: "eraser" }
  | { type: "scroll" };

/**
 * 一个笔迹点。x/y 为归一化坐标（逻辑宽 1000 基准），p 为压力（0–1，无压感设备
 * 恒为 0.5），t 为相对本笔起点经过的毫秒数（供老师端笔迹回放按真实节奏重演）。
 */
export interface InkStrokePoint {
  x: number;
  y: number;
  p: number;
  t: number;
}

/** 一笔完整笔画。橡皮不产生笔画，而是删除已有笔画（整笔橡皮，见 erase.ts） */
export interface InkStroke {
  tool: "pen" | "highlighter";
  /** CSS 颜色字符串（荧光笔带 alpha，如 rgba(250,204,21,0.45)） */
  color: string;
  /** 归一化线宽（逻辑宽 1000 下的数值，重绘按容器宽度反算） */
  weight: number;
  points: InkStrokePoint[];
}

/** Atrament 引擎（页内答题区）的矢量数据 */
export interface InkAtramentData {
  /** 恒为 1000：标注坐标归一化基准，读写双方据此换算 */
  width: typeof INK_LOGICAL_WIDTH;
  strokes: InkStroke[];
}

/**
 * Excalidraw 引擎（全屏作答）的数据：直接存库原生场景 JSON（serializeAsJSON
 * 的解析结果），本引擎不解释其内部结构（§5.4.0：用库时存库自己的 JSON）。
 */
export interface InkExcalidrawData {
  scene: Record<string, unknown>;
}

/** 各引擎对应的 data 载荷类型 */
export interface InkDocDataByEngine {
  atrament: InkAtramentData;
  excalidraw: InkExcalidrawData;
}

/** 手写文档：所有落库/上传/草稿的统一外层格式 */
export interface InkDoc<E extends InkEngineKind = InkEngineKind> {
  engine: E;
  version: 1;
  data: InkDocDataByEngine[E];
  /** 最后变更时间（epoch 毫秒）。load 外部文档时原样保留，保证往返一致 */
  updatedAt: number;
}

/** 笔/荧光笔的绘制参数（逻辑单位）；适配器负责换算到容器实际宽度 */
export interface InkBrushSpec {
  color: string;
  weight: number;
}

/** 三档笔粗细（逻辑单位，宽度 1000 基准；2–3 档粗细） */
export const INK_PEN_SIZES: Record<InkPenSize, number> = {
  thin: 2.5,
  medium: 4,
  thick: 6,
};

/** 笔颜色 → CSS 颜色（黑/蓝/红） */
export const INK_PEN_COLORS: Record<InkPenColor, string> = {
  black: "#1f2328",
  blue: "#1d4ed8",
  red: "#dc2626",
};

/** 荧光笔：黄色半透明、加粗（alpha 保证覆盖在笔迹上仍可透出字） */
export const INK_HIGHLIGHTER: InkBrushSpec = {
  color: "rgba(250, 204, 21, 0.45)",
  weight: 16,
};

/** 整笔橡皮命中半径（逻辑单位） */
export const INK_ERASE_RADIUS = 14;

/** 默认笔配置 */
export const DEFAULT_INK_TOOL: Required<
  Extract<InkToolConfig, { type: "pen" }>
> = {
  type: "pen",
  color: "black",
  size: "medium",
};

/**
 * 把 InkToolConfig 解析成具体绘制参数（纯函数，供适配器与测试使用）。
 * pen 类的可选属性缺省时沿用 base（上一次生效值）。
 */
export function resolveToolSpec(
  tool: InkToolConfig,
  base: { color: InkPenColor; size: InkPenSize },
): {
  brush: InkBrushSpec | null;
  base: { color: InkPenColor; size: InkPenSize };
} {
  switch (tool.type) {
    case "pen": {
      const next = {
        color: tool.color ?? base.color,
        size: tool.size ?? base.size,
      };
      return {
        brush: {
          color: INK_PEN_COLORS[next.color],
          weight: INK_PEN_SIZES[next.size],
        },
        base: next,
      };
    }
    case "highlighter":
      return { brush: INK_HIGHLIGHTER, base };
    case "eraser":
    case "scroll":
      return { brush: null, base };
  }
}
