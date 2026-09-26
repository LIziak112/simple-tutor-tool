/**
 * InkSurface 统一适配层接口（T2.7，架构 §5.4.0）。
 *
 * 一切消费方（答题页、草稿、上传、老师查看、回放）只依赖这个接口，
 * 不直接 import 绘制库。以后换库（包括将来换成原生 PencilKit）只需
 * 重写一个适配器。适配器可附加能力（如 setTool），引擎层（index.ts）负责
 * 把固定 API 转发到适配器。
 */
import type { InkDoc, InkToolConfig } from "./types.ts";

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
  /** 每一笔结束（含撤销/重做/清空/load 等任何状态变化）触发，用于草稿保存 */
  onChange(cb: (doc: InkDoc) => void): () => void;
  destroy(): void;
}

/** 支持工具切换的适配器（两个适配器都实现） */
export interface ToolAwareSurface extends InkSurface {
  setTool(tool: InkToolConfig): void;
  /** 撤销/重做可用性（工具栏按钮禁用态） */
  canUndo(): boolean;
  canRedo(): boolean;
}
