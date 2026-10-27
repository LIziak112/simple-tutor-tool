/**
 * 手写引擎对外入口（T2.7，任务要点：API 固定）。
 *
 *   const ink = create(container, { engine: "atrament" });
 *   ink.getData() / load(data) / exportPng() / undo() / redo() / clear()
 *   ink.setTool(...) / ink.on("change", cb) / ink.destroy()
 *
 * 内部 = InkSurface 适配层（surface.ts）+ 两个适配器：
 * - atrament：页内答题区（默认形态）；
 * - excalidraw：历史场景兼容（mount 时才动态 import，独立 chunk 不进主包）。
 * 状态/历史在纯数据层（history.ts），引擎与适配器只是转发。
 */
import {
  type InkProfileConfig,
  inkRenderingOf,
  type NoteBackground,
} from "@tutor/contract";
import { getInkProfileSelection } from "../ink-profile-store";
import { createFeelSurface } from "../lab/feel-surface";
import { createAtramentSurface } from "./atrament-adapter.ts";
import { createExcalidrawSurface } from "./excalidraw-adapter.ts";
import { InkStore } from "./history";
import type { InkChangeReason, ToolAwareSurface } from "./surface.ts";
import type {
  InkDoc,
  InkEngineKind,
  InkInputMode,
  InkToolConfig,
} from "./types.ts";

/**
 * 空 atrament 文档工厂（T6R.9 复审⑭收敛）：HandwrittenControls（清空改
 * 页内手写/无笔迹初始态）与 note 测试夹具共用一份——updatedAt 取当下
 * （mergeInkDocs 的新者胜口径依赖它）。
 */
export function emptyAtramentDoc(): InkDoc<"atrament"> {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: Date.now(),
  };
}

export type { InkHistoryEntry } from "./history.ts";
export { InkStore } from "./history.ts";
export type {
  InkChangeReason,
  InkSurface,
  ToolAwareSurface,
} from "./surface.ts";
export * from "./types.ts";

export interface InkEngineOptions {
  /** 底层引擎：atrament（页内答题区，默认）/ excalidraw（历史场景） */
  engine?: InkEngineKind;
  /** 恢复的笔迹（草稿） */
  initial?: InkDoc;
  /** atrament 初始高度提示（CSS 像素；容器高度由外部样式控制） */
  height?: number;
  /**
   * 输入模式（T6R.7，仅 atrament 生效）：缺省 auto=旧行为（自动探测，
   * 旧作答组件零变化）；pen=笔写／手指滚动；finger=手指书写。
   */
  inputMode?: InkInputMode;
  /**
   * 纸张背景（T6R.7，仅 atrament 生效）：缺省 white=不设置任何背景样式。
   */
  background?: NoteBackground;
  /**
   * LR-2：墓碑点数预算（透传 InkStore）。正式手写链传 INK_MAX_DELETED_POINTS
   * （60k，与 inkDocSchema 服务端限额同值——413 后无自愈路径，客户端先压实）；
   * 草稿链缺省 NOTE_MAX_DELETED_POINTS（100k）。
   */
  maxDeletedPoints?: number;
  /** 引擎就绪回调（excalidraw 懒加载完成后触发；atrament 同步就绪） */
  onReady?: () => void;
  /** 懒加载失败回调（用于展示错误态与重试） */
  onError?: (err: Error) => void;
}

/** 引擎对外 API（固定；canUndo/canRedo 供工具栏禁用态，属附加查询） */
export interface InkEngine {
  setProfile?(config: InkProfileConfig): void;
  getData(): InkDoc;
  finish?(): void;
  setInputEnabled?(enabled: boolean): void;
  load(data: InkDoc): void;
  exportPng(): Promise<Blob>;
  undo(): void;
  redo(): void;
  clear(): void;
  setTool(tool: InkToolConfig): void;
  /**
   * 输入模式（T6R.7）：恒存在——守卫收敛在引擎包装层（复审⑩），内部按
   * surface 是否实现降级；excalidraw 引擎调用为安全 no-op（全屏作答无
   * 此概念）。运行时切换只影响新落下的指针。
   */
  setInputMode(mode: InkInputMode): void;
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
  const store = new InkStore({
    ...(opts.maxDeletedPoints !== undefined
      ? { maxDeletedPoints: opts.maxDeletedPoints }
      : {}),
  });
  let config = getInkProfileSelection().config;
  let inputEnabled = true;
  let inputMode = opts.inputMode ?? config.inputMode;
  let currentTool: InkToolConfig = {
    type: "pen",
    color: config.color,
    size: config.size,
  };
  const subscribers = new Set<(doc: InkDoc, reason: InkChangeReason) => void>();
  let unsubscribe: (() => void) | null = null;
  const build = (): ToolAwareSurface =>
    opts.engine === "excalidraw"
      ? createExcalidrawSurface({
          ...(opts.onReady ? { onReady: opts.onReady } : {}),
          ...(opts.onError ? { onError: opts.onError } : {}),
        })
      : config.renderer === "freehand"
        ? createFeelSurface(
            { ...config, smoothing: Math.min(1, config.smoothing) },
            {
              store,
              preserveRendering: true,
              ...(opts.background ? { background: opts.background } : {}),
            },
          )
        : createAtramentSurface({
            store,
            smoothing: config.smoothing,
            rendering: inkRenderingOf(config),
            ...(opts.height !== undefined ? { height: opts.height } : {}),
            ...(opts.inputMode !== undefined
              ? { inputMode: opts.inputMode }
              : {}),
            ...(opts.background !== undefined
              ? { background: opts.background }
              : {}),
          });

  let surface = build();
  const connect = () => {
    unsubscribe = surface.onChange((doc, reason) => {
      for (const cb of subscribers) cb(doc, reason);
    });
    surface.setTool(currentTool);
    surface.setInputMode?.(inputMode);
    surface.setInputEnabled?.(inputEnabled);
  };
  surface.mount(container, opts.initial);
  connect();
  if (opts.engine !== "excalidraw") opts.onReady?.(); // atrament 同步就绪

  return {
    setProfile(next) {
      if (JSON.stringify(next) === JSON.stringify(config)) return;
      if (opts.engine === "excalidraw") return;
      surface.finish?.();
      const doc = surface.getDoc();
      unsubscribe?.();
      surface.destroy();
      config = next;
      inputMode = next.inputMode;
      if (currentTool.type === "pen")
        currentTool = { type: "pen", color: next.color, size: next.size };
      surface = build();
      surface.mount(container, doc);
      connect();
    },
    getData: () => surface.getDoc(),
    finish: () => surface.finish?.(),
    setInputEnabled: (enabled) => {
      inputEnabled = enabled;
      surface.setInputEnabled?.(enabled);
    },
    load: (data) => surface.load(data),
    exportPng: () => surface.exportPng(),
    undo: () => surface.undo(),
    redo: () => surface.redo(),
    clear: () => surface.clear(),
    setTool: (tool) => {
      currentTool = tool;
      surface.setTool(tool);
    },
    // 守卫收敛于此（复审⑩）：surface 未实现（excalidraw）时安全 no-op，
    // 调用方（InkPad 等）无需 ?. 链
    setInputMode: (mode: InkInputMode) => {
      inputMode = mode;
      surface.setInputMode?.(mode);
    },
    on: (event, cb) =>
      event === "change"
        ? (() => {
            subscribers.add(cb);
            return () => subscribers.delete(cb);
          })()
        : (
            () => () =>
              undefined
          )(),
    canUndo: () => surface.canUndo(),
    canRedo: () => surface.canRedo(),
    destroy: () => {
      unsubscribe?.();
      surface.destroy();
      subscribers.clear();
    },
  };
}
