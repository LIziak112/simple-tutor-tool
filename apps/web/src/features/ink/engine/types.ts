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
  InkDoc as ContractInkDoc,
  InkEngineKind as ContractInkEngineKind,
  InkExcalidrawData as ContractInkExcalidrawData,
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

/** 工具类型：笔 / 荧光笔 / 整笔橡皮 / 滚动模式（无笔设备的回退开关，§5.4.1 输入层第 3 条） */
export type InkToolType = "pen" | "highlighter" | "eraser" | "scroll";

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

/** CSS 颜色 → 笔颜色档位（逆向查找表，模块级一次构建，零分配查询） */
const PEN_COLOR_BY_CSS = new Map<string, InkPenColor>(
  Object.entries(INK_PEN_COLORS).map(([k, v]) => [v, k as InkPenColor]),
);

/** 逻辑线宽 → 笔粗细档位（逆向查找表） */
const PEN_SIZE_BY_WEIGHT = new Map<number, InkPenSize>(
  Object.entries(INK_PEN_SIZES).map(([k, v]) => [v, k as InkPenSize]),
);

/**
 * 笔画 → 工具配置（resolveToolSpec 的逆向；重放、统计、合成注入共用）。
 * InkStroke 只存 CSS 颜色与逻辑线宽（契约形状），档位在此反查；
 * 未知值回退默认笔（black/medium），不抛错——回退语义集中在引擎层，
 * 消费方不再各自 Object.entries 扫描。
 */
export function toolConfigFromStroke(stroke: InkStroke): InkToolConfig {
  if (stroke.tool === "highlighter") return { type: "highlighter" };
  return {
    type: "pen",
    color: PEN_COLOR_BY_CSS.get(stroke.color) ?? "black",
    size: PEN_SIZE_BY_WEIGHT.get(stroke.weight) ?? "medium",
  };
}
