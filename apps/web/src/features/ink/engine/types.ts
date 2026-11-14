/**
 * 手写引擎数据结构（T2.7 建立；T2.8 起 InkDoc 形状沉到 @tutor/contract，
 * 本文件 re-export 契约推断类型——前后端单一事实来源，禁止两边手写）。
 *
 * 核心约定：
 * - 矢量坐标一律**归一化到逻辑宽度 1000**（INK_LOGICAL_WIDTH）——横竖屏旋转、
 *   换设备都能无损重绘；
 * - 状态与历史（撤销/重做/变更通知）放纯数据层（history.ts），不碰 DOM/canvas，
 *   可完整单测；适配器层保持薄；
 * - 数据库与文件只存 InkDoc（库自己的 JSON 格式 + engine 字段），消费方只依赖
 *   InkSurface 接口（surface.ts），不直接 import 绘制库。
 *
 * 泛型 InkDoc<E> 是契约联合的 Extract 别名：`InkDoc<"atrament">` 收窄到
 * atrament 分支（data.strokes 可安全访问），`InkDoc`（缺省）是完整联合。
 */
import type {
  InkAtramentData as ContractInkAtramentData,
  InkDeletedStroke as ContractInkDeletedStroke,
  InkDoc as ContractInkDoc,
  InkEngineKind as ContractInkEngineKind,
  InkExcalidrawData as ContractInkExcalidrawData,
  InkPointerKind as ContractInkPointerKind,
  InkStroke as ContractInkStroke,
  InkStrokePoint as ContractInkStrokePoint,
} from "@tutor/contract";

export { INK_LOGICAL_WIDTH } from "@tutor/contract";

/** 底层绘制引擎（InkSurface 适配层后面的实现） */
export type InkEngineKind = ContractInkEngineKind;

/** 手写文档：所有落库/上传/草稿的统一外层格式（契约 inkDocSchema 的推断类型） */
export type InkDoc<E extends InkEngineKind = InkEngineKind> = Extract<
  ContractInkDoc,
  { engine: E }
>;

/** LR-2：擦除墓碑（契约 inkDeletedStrokeSchema 的推断类型，re-export 单源） */
export type InkDeletedStroke = ContractInkDeletedStroke;

/** LR-1：落笔输入来源（pointerType 直录） */
export type InkPointerKind = ContractInkPointerKind;

/**
 * LR-1 守卫：PointerEvent.pointerType 规范允许空串（合成事件 / 个别驱动），
 * 非法值不采集（落成 pointer:"" 会让整份文档过不了 zod）。
 */
export function asPointerKind(value: string): InkPointerKind | undefined {
  return value === "pen" || value === "touch" || value === "mouse"
    ? value
    : undefined;
}

/** 一个笔迹点（契约形状：x/y 归一化坐标、p 压力 0–1、t 相对本笔毫秒） */
export type InkStrokePoint = ContractInkStrokePoint;

/** 一笔完整笔画。橡皮不产生笔画，而是删除已有笔画（整笔橡皮，见 erase.ts） */
export type InkStroke = ContractInkStroke;

/** Atrament 引擎（页内答题区）的矢量数据 */
export type InkAtramentData = ContractInkAtramentData;

/** Excalidraw 引擎（全屏作答）的数据：库原生场景 JSON（§5.4.0） */
export type InkExcalidrawData = ContractInkExcalidrawData;

/** 各引擎对应的 data 载荷类型 */
export interface InkDocDataByEngine {
  atrament: InkAtramentData;
  excalidraw: InkExcalidrawData;
}

/**
 * 工具类型：笔 / 荧光笔 / 橡皮 / 形状 / 滚动模式（无笔设备的回退开关，§5.4.1
 * 输入层第 3 条）。形状落成普通 pen 笔画，橡皮不产生笔画——落库形状不变。
 */
export type InkToolType = "pen" | "highlighter" | "eraser" | "shape" | "scroll";

/**
 * 输入模式（T6R.7，方案 §4.1）：
 * - auto：旧行为（缺省）——自动探测：见过笔后手指不再落墨（penOnly 防手掌），
 *   未见笔时手指/鼠标直接书写。旧手写作答组件零变化地停留在此档；
 * - pen：新草稿缺省「笔写／手指滚动」——手指恒不落墨（=页面滚动），笔与鼠标书写；
 * - finger：工具菜单「手指书写」切换——手指直接书写（无手掌防误触语义）。
 * 模式切换只影响**新落下**的指针，在途笔画不被打断。不以 UA 推断设备，
 * 由调用方（会话输入偏好/用户操作）决定。
 */
export type InkInputMode = "auto" | "pen" | "finger";

/**
 * 笔粗细档位。账号手感设置（契约 ink-profile）只用 thin/medium/thick 三档，
 * 工具栏另开放极细与特粗；笔画只存逻辑线宽，档位增减不动契约。
 */
export type InkPenSize = "hairline" | "thin" | "medium" | "thick" | "heavy";

/** 笔颜色。账号手感设置只用黑/蓝/红，工具栏另开放绿/橙/紫。 */
export type InkPenColor =
  | "black"
  | "blue"
  | "red"
  | "green"
  | "orange"
  | "purple";

/** 荧光笔颜色（均为半透明色，盖在字上仍能透出字） */
export type InkHighlighterColor =
  | "yellow"
  | "green"
  | "blue"
  | "pink"
  | "orange";

/** 荧光笔粗细档位 */
export type InkHighlighterSize = "thin" | "medium" | "thick";

/** 橡皮模式：stroke 碰到即删整笔；partial 只擦掉碰到的那一段 */
export type InkEraserMode = "stroke" | "partial";

/** 橡皮大小档位 */
export type InkEraserSize = "small" | "medium" | "large";

/** 形状工具的形状种类 */
export type InkShapeKind = "line" | "arrow" | "rect" | "ellipse";

/** 一笔的成形方式：free 为手写轨迹，其余由起止点生成 */
export type InkStrokeShape = "free" | InkShapeKind;

/**
 * setTool 参数。pen/shape 的颜色与粗细缺省表示沿用上一次的设置（两者共用同一
 * 份记忆）；其余可选属性缺省取固定缺省值（黄色中档荧光笔、整笔中号橡皮、直线）。
 */
export type InkToolConfig =
  | { type: "pen"; color?: InkPenColor; size?: InkPenSize }
  | {
      type: "highlighter";
      color?: InkHighlighterColor;
      size?: InkHighlighterSize;
      /** 画直线：起止点连成一条线，接近水平或竖直时吸附 */
      straight?: boolean;
    }
  | { type: "eraser"; mode?: InkEraserMode; size?: InkEraserSize }
  | {
      type: "shape";
      shape?: InkShapeKind;
      color?: InkPenColor;
      size?: InkPenSize;
    }
  | { type: "scroll" };

/** 笔/荧光笔的绘制参数（逻辑单位）；适配器负责换算到容器实际宽度 */
export interface InkBrushSpec {
  color: string;
  weight: number;
}

/** 默认低平滑强度，实时书写、导出与回放使用同一设置。 */
export const INK_DEFAULT_SMOOTHING = 0.35;

/** 笔粗细（逻辑单位，宽度 1000 基准）。thin/medium/thick 的取值不可改：已落库笔迹按线宽反查档位 */
export const INK_PEN_SIZES: Record<InkPenSize, number> = {
  hairline: 1.5,
  thin: 2.5,
  medium: 4,
  thick: 6,
  heavy: 9,
};

/** 笔颜色 → CSS 颜色。黑/蓝/红的取值不可改：已落库笔迹按颜色反查档位 */
export const INK_PEN_COLORS: Record<InkPenColor, string> = {
  black: "#1f2328",
  blue: "#1d4ed8",
  red: "#dc2626",
  green: "#15803d",
  orange: "#ea580c",
  purple: "#7e22ce",
};

/** 荧光笔颜色 → CSS 颜色（统一 0.45 透明度；yellow 即旧版唯一的荧光笔颜色） */
export const INK_HIGHLIGHTER_COLORS: Record<InkHighlighterColor, string> = {
  yellow: "rgba(250, 204, 21, 0.45)",
  green: "rgba(74, 222, 128, 0.45)",
  blue: "rgba(96, 165, 250, 0.45)",
  pink: "rgba(244, 114, 182, 0.45)",
  orange: "rgba(251, 146, 60, 0.45)",
};

/** 荧光笔粗细（逻辑单位；medium 即旧版唯一的荧光笔线宽） */
export const INK_HIGHLIGHTER_SIZES: Record<InkHighlighterSize, number> = {
  thin: 10,
  medium: 16,
  thick: 26,
};

/** 缺省荧光笔：黄色半透明、中档线宽 */
export const INK_HIGHLIGHTER: InkBrushSpec = {
  color: INK_HIGHLIGHTER_COLORS.yellow,
  weight: INK_HIGHLIGHTER_SIZES.medium,
};

/** 橡皮命中半径（逻辑单位；medium 即旧版唯一的橡皮半径） */
export const INK_ERASER_SIZES: Record<InkEraserSize, number> = {
  small: 8,
  medium: 14,
  large: 24,
};

/** 缺省橡皮命中半径（逻辑单位） */
export const INK_ERASE_RADIUS = INK_ERASER_SIZES.medium;

/** 默认笔配置 */
export const DEFAULT_INK_TOOL: Required<
  Extract<InkToolConfig, { type: "pen" }>
> = {
  type: "pen",
  color: "black",
  size: "medium",
};

/** 笔与形状共用的颜色、粗细记忆 */
export interface InkPenBase {
  color: InkPenColor;
  size: InkPenSize;
}

/**
 * 把 InkToolConfig 解析成具体绘制参数（纯函数，供适配器与测试使用）。
 * pen/shape 的可选属性缺省时沿用 base（上一次生效值）。
 */
export function resolveToolSpec(
  tool: InkToolConfig,
  base: InkPenBase,
): {
  brush: InkBrushSpec | null;
  base: InkPenBase;
} {
  switch (tool.type) {
    case "pen":
    case "shape": {
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
      return {
        brush: {
          color: INK_HIGHLIGHTER_COLORS[tool.color ?? "yellow"],
          weight: INK_HIGHLIGHTER_SIZES[tool.size ?? "medium"],
        },
        base,
      };
    case "eraser":
    case "scroll":
      return { brush: null, base };
  }
}

/**
 * 一次落笔要做的事（落笔时按当时的工具配置取快照，一笔之内不再变）：
 * - draw：落成一笔 pen/highlighter 笔画，shape 决定点序列怎么来；
 * - erase：整笔或局部擦除，radius 为逻辑单位；
 * - none：滚动模式，不接管指针。
 */
export type InkGesture =
  | {
      kind: "draw";
      tool: "pen" | "highlighter";
      brush: InkBrushSpec;
      shape: InkStrokeShape;
    }
  | { kind: "erase"; mode: InkEraserMode; radius: number }
  | { kind: "none" };

/** 工具配置 → 落笔手势（纯函数；三个书写面与材料圈画共用，避免各自分支漂移） */
export function resolveGesture(
  tool: InkToolConfig,
  base: InkPenBase,
): { gesture: InkGesture; base: InkPenBase } {
  const resolved = resolveToolSpec(tool, base);
  const draw = (
    stroke: "pen" | "highlighter",
    shape: InkStrokeShape,
  ): InkGesture =>
    resolved.brush
      ? { kind: "draw", tool: stroke, brush: resolved.brush, shape }
      : { kind: "none" };
  switch (tool.type) {
    case "pen":
      return { gesture: draw("pen", "free"), base: resolved.base };
    case "shape":
      return {
        gesture: draw("pen", tool.shape ?? "line"),
        base: resolved.base,
      };
    case "highlighter":
      return {
        gesture: draw("highlighter", tool.straight ? "line" : "free"),
        base: resolved.base,
      };
    case "eraser":
      return {
        gesture: {
          kind: "erase",
          mode: tool.mode ?? "stroke",
          radius: INK_ERASER_SIZES[tool.size ?? "medium"],
        },
        base: resolved.base,
      };
    case "scroll":
      return { gesture: { kind: "none" }, base: resolved.base };
  }
}

/** 取值 → 档位的逆向查找表（模块级一次构建，零分配查询） */
function invert<K extends string, V>(record: Record<K, V>): Map<V, K> {
  return new Map(
    (Object.entries(record) as Array<[K, V]>).map(([key, value]) => [
      value,
      key,
    ]),
  );
}

const PEN_COLOR_BY_CSS = invert(INK_PEN_COLORS);
const PEN_SIZE_BY_WEIGHT = invert(INK_PEN_SIZES);
const HIGHLIGHTER_COLOR_BY_CSS = invert(INK_HIGHLIGHTER_COLORS);
const HIGHLIGHTER_SIZE_BY_WEIGHT = invert(INK_HIGHLIGHTER_SIZES);

/**
 * 笔画 → 工具配置（resolveToolSpec 的逆向；重放、统计、合成注入共用）。
 * InkStroke 只存 CSS 颜色与逻辑线宽（契约形状），档位在此反查；
 * 未知值回退缺省档位（笔 black/medium、荧光笔 yellow/medium），不抛错——回退
 * 语义集中在引擎层，消费方不再各自 Object.entries 扫描。形状笔画与手写笔画
 * 落库形状相同，一律反查为 pen。
 */
export function toolConfigFromStroke(stroke: InkStroke): InkToolConfig {
  if (stroke.tool === "highlighter") {
    return {
      type: "highlighter",
      color: HIGHLIGHTER_COLOR_BY_CSS.get(stroke.color) ?? "yellow",
      size: HIGHLIGHTER_SIZE_BY_WEIGHT.get(stroke.weight) ?? "medium",
    };
  }
  return {
    type: "pen",
    color: PEN_COLOR_BY_CSS.get(stroke.color) ?? "black",
    size: PEN_SIZE_BY_WEIGHT.get(stroke.weight) ?? "medium",
  };
}
