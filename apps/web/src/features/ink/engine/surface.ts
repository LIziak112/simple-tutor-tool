/**
 * InkSurface 统一适配层接口（T2.7，架构 §5.4.0）。
 *
 * 一切消费方（答题页、草稿、上传、老师查看、回放）只依赖这个接口，
 * 不直接 import 绘制库。以后换库（包括将来换成原生 PencilKit）只需
 * 重写一个适配器。适配器可附加能力（如 setTool），引擎层（index.ts）负责
 * 把固定 API 转发到适配器。
 */
import type { InkDoc, InkInputMode, InkToolConfig } from "./types.ts";

/**
 * 笔迹变化的触发原因（T4.0b，§5.0-C14）：
 * - stroke：书写一笔结束（含荧光笔）；缺省值——老适配器/老调用方不带 reason
 *   时按此处理（零影响）；
 * - erase：整笔橡皮一次拖动提交；
 * - undo / redo：历史栈操作；
 * - clear：清空画布；
 * - load：载入外部文档（全屏进出在页内/全屏两引擎间移交笔迹触发 load）——
 *   **消费方把 load 排除在 inkEditCount 之外**（不得计成编辑，§5.0-C14）。
 */
export type InkChangeReason =
  | "stroke"
  | "erase"
  | "undo"
  | "redo"
  | "clear"
  | "load";

export interface InkSurface {
  /** 挂载到容器元素（适配器自建 canvas 等内部结构）；initial 为恢复的笔迹 */
  mount(el: HTMLElement, initial?: InkDoc): void;
  /** 当前笔迹文档快照（数据层唯一数据源的投影） */
  getDoc(): InkDoc;
  /** 载入外部文档（load(getData()) 往返一致的实现基础） */
  load(data: InkDoc): void;
  /** 导出白底 PNG（供老师和 AI 查看） */
  exportPng(): Promise<Blob>;
  undo(): void;
  redo(): void;
  clear(): void;
  /**
   * 每次状态变化触发（stroke/erase/undo/redo/clear/load），用于草稿保存与
   * 埋点分型（T4.0b ink_edit_batch）。reason 缺省 "stroke"（老回调忽略第二参
   * 零影响；TS 少参函数可赋给多参签名）。
   */
  onChange(cb: (doc: InkDoc, reason: InkChangeReason) => void): () => void;
  destroy(): void;
}

/** 支持工具切换的适配器（两个适配器都实现） */
export interface ToolAwareSurface extends InkSurface {
  setTool(tool: InkToolConfig): void;
  /**
   * 输入模式（T6R.7，方案 §4.1）：可选能力——仅 atrament 适配器实现
   * （excalidraw 全屏作答无此概念）。缺省/不实现 = auto（旧自动探测行为）。
   */
  setInputMode?(mode: InkInputMode): void;
  /** 撤销/重做可用性（工具栏按钮禁用态） */
  canUndo(): boolean;
  canRedo(): boolean;
}
