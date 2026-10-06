/**
 * 手写引擎对外入口（T2.7，任务要点：API 固定）。
 *
 *   const ink = create(container, { engine: "atrament" });
 *   ink.getData() / load(data) / exportPng() / undo() / redo() / clear()
 *   ink.setTool(...) / ink.on("change", cb) / ink.destroy()
 *
 * 内部 = InkSurface 适配层（surface.ts）+ 两个适配器：
 * - atrament：页内答题区（默认形态）；
 * - excalidraw：全屏作答（mount 时才动态 import，独立 chunk 不进主包）。
 * 状态/历史在纯数据层（history.ts），引擎与适配器只是转发。
 */
import { createAtramentSurface } from "./atrament-adapter.ts";
import { createExcalidrawSurface } from "./excalidraw-adapter.ts";
import type { InkChangeReason, ToolAwareSurface } from "./surface.ts";
import type { InkDoc, InkEngineKind, InkToolConfig } from "./types.ts";

export type { InkHistoryEntry } from "./history.ts";
export { InkStore } from "./history.ts";
export type {
  InkChangeReason,
  InkSurface,
  ToolAwareSurface,
} from "./surface.ts";
export * from "./types.ts";

export interface InkEngineOptions {
  /** 底层引擎：atrament（页内答题区，默认）/ excalidraw（全屏作答） */
  engine?: InkEngineKind;
  /** 恢复的笔迹（草稿） */
  initial?: InkDoc;
  /** atrament 初始高度提示（CSS 像素；容器高度由外部样式控制） */
  height?: number;
  /** 引擎就绪回调（excalidraw 懒加载完成后触发；atrament 同步就绪） */
  onReady?: () => void;
  /** 懒加载失败回调（用于展示错误态与重试） */
  onError?: (err: Error) => void;
}

/** 引擎对外 API（固定；canUndo/canRedo 供工具栏禁用态，属附加查询） */
export interface InkEngine {
  getData(): InkDoc;
  load(data: InkDoc): void;
  exportPng(): Promise<Blob>;
  undo(): void;
  redo(): void;
  clear(): void;
  setTool(tool: InkToolConfig): void;
  /**
   * 每次状态变化触发（reason：stroke/erase/undo/redo/clear/load，§5.0-C14）；
   * 返回取消订阅函数。老回调（只收 doc）仍可注册——reason 缺省语义见 surface.ts。
   */
  on(
    event: "change",
    cb: (doc: InkDoc, reason: InkChangeReason) => void,
  ): () => void;
  /** 工具栏禁用态查询（附加能力） */
  canUndo(): boolean;
  canRedo(): boolean;
  destroy(): void;
}

/**
 * 创建手写引擎并挂载到容器。excalidraw 的资源加载是异步的：mount 内部动态
 * import，期间 getData() 返回初始/空文档，其余操作在就绪后生效。
 */
export function create(
  container: HTMLElement,
  opts: InkEngineOptions = {},
): InkEngine {
  // exactOptionalPropertyTypes：不把 undefined 显式传给可选属性
  const surface: ToolAwareSurface =
    opts.engine === "excalidraw"
      ? createExcalidrawSurface({
          ...(opts.onReady ? { onReady: opts.onReady } : {}),
          ...(opts.onError ? { onError: opts.onError } : {}),
        })
      : createAtramentSurface(
          opts.height !== undefined ? { height: opts.height } : {},
        );

  surface.mount(container, opts.initial);
  if (opts.engine !== "excalidraw") opts.onReady?.(); // atrament 同步就绪

  return {
    getData: () => surface.getDoc(),
    load: (data) => surface.load(data),
    exportPng: () => surface.exportPng(),
    undo: () => surface.undo(),
    redo: () => surface.redo(),
    clear: () => surface.clear(),
    setTool: (tool) => surface.setTool(tool),
    on: (event, cb) =>
      event === "change"
        ? surface.onChange(cb)
        : (
            () => () =>
              undefined
          )(),
    canUndo: () => surface.canUndo(),
    canRedo: () => surface.canRedo(),
    destroy: () => surface.destroy(),
  };
}
