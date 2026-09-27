/**
 * Excalidraw 适配器（T2.7，全屏作答形态，架构 §5.4.0）。
 *
 * 要点：
 * - **懒加载**：@excalidraw/excalidraw 只在 mount 时动态 import()，独立
 *   chunk 不进主包（ui-conventions 性能要求）；
 * - **禁 CDN**：Excalidraw 默认从 unpkg 拉字体等资源，必须在 import 前把
 *   window.EXCALIDRAW_ASSET_PATH 指向本站静态目录（vite 插件把包内字体
 *   发布到 /excalidraw-assets/，见 apps/web/vite.config.ts）；
 * - 中文界面 langCode="zh-CN"，UIOptions 精简（隐藏加载/导出/存盘等，
 *   保留清空画布）；工具映射：笔/荧光笔→自由画笔 freedraw、橡皮→橡皮、
 *   套索（scroll 工具位）→选择；
 * - 撤销/重做：Excalidraw 无命令式 undo API，适配器内维护场景快照栈
 *   （元素数组引用比较判断真实变更，updateScene 恢复），语义与数据层一致；
 * - 数据：InkDoc.data.scene 存 serializeAsJSON 的解析结果（库原生 JSON，
 *   engine 字段区分）；load 用 restore + updateScene 恢复。
 *
 * 适配器内部用 react-dom/client 挂一个独立 React 子树（引擎保持纯 TS，
 * 用 createElement 而非 JSX）。
 */

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
// 类型走包的深层 types 导出（入口 index 未 re-export 这些类型名）；
// 仅 import type，不产生任何运行时代码
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolAwareSurface } from "./surface.ts";
import type { InkDoc, InkToolConfig } from "./types.ts";

declare global {
  interface Window {
    /** Excalidraw 静态资源根路径（字体等）。必须指向本站目录，禁止 CDN */
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** 本站静态资源目录（vite 插件在 dev/build 时提供） */
const ASSET_PATH = "/excalidraw-assets/";

export interface ExcalidrawSurfaceOptions {
  /** 库与界面就绪后回调（懒加载完成） */
  onReady?: () => void;
  /** 动态 import 失败回调（展示错误态与重试入口） */
  onError?: (err: Error) => void;
}

interface Snapshot {
  elements: readonly ExcalidrawElement[];
}

export function createExcalidrawSurface(
  options: ExcalidrawSurfaceOptions = {},
): ToolAwareSurface {
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  /** root.render 是否已调用（未渲染的 root 不能 unmount，否则 React 报错） */
  let rendered = false;
  let api: ExcalidrawImperativeAPI | null = null;
  let destroyed = false;

  /** 最近一次场景元素（引用比较识别真实变更） */
  let lastElements: readonly ExcalidrawElement[] = [];
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  /** 自己 updateScene 引起的变化不进入快照栈 */
  let applying = false;

  let updatedAt = 0;
  const listeners = new Set<(doc: InkDoc) => void>();
  /** 就绪前排队的命令（setTool/undo/redo/clear/load） */
  const queue: Array<() => void> = [];

  function notify(): void {
    updatedAt = Date.now();
    const doc = surface.getDoc();
    for (const cb of listeners) cb(doc);
  }

  /** 场景真实变化（非自己 updateScene）：入撤销栈并通知 */
  function pushSnapshot(next: readonly ExcalidrawElement[]): void {
    if (applying) {
      lastElements = next;
      return;
    }
    if (next !== lastElements) {
      undoStack.push({ elements: lastElements });
      redoStack.length = 0;
      lastElements = next;
      notify();
    }
  }

  function runWhenReady(fn: () => void): void {
    if (api) fn();
    else queue.push(fn);
  }

  const surface: ToolAwareSurface = {
    mount(el: HTMLElement, initial?: InkDoc): void {
      el.style.position = "relative";
      el.style.overflow = "hidden";

      const host = document.createElement("div");
      host.style.position = "absolute";
      host.style.inset = "0";
      el.appendChild(host);
      root = createRoot(host);
      // 禁 CDN：在任何加载发生之前指向本站静态目录
      window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;

      void (async () => {
        try {
          // 样式与库都走动态 import：独立 chunk，只在进入全屏作答时下载
          await import("@excalidraw/excalidraw/index.css");
          const mod = await import("@excalidraw/excalidraw");
          if (destroyed) return;

          const initialElements = initial
            ? (mod.restore({ elements: sceneElements(initial) }, null, null)
                .elements ?? [])
            : [];
          lastElements = initialElements;

          root?.render(
            createElement(mod.Excalidraw, {
              langCode: "zh-CN",
              theme: "light",
              name: "手写作答",
              initialData: {
                elements: initialElements,
                appState: { viewBackgroundColor: "#ffffff" },
              },
              UIOptions: {
                canvasActions: {
                  loadScene: false,
                  saveToActiveFile: false,
                  saveAsImage: false,
                  export: false,
                  toggleTheme: null,
                  changeViewBackgroundColor: false,
                  clearCanvas: true,
                },
                tools: { image: false },
              },
              excalidrawAPI: (instance: ExcalidrawImperativeAPI) => {
                api = instance;
                // 初始场景不进入撤销栈底（与 atrament 空画布语义一致）
                while (queue.length > 0) {
                  const fn = queue.shift();
                  fn?.();
                }
                options.onReady?.();
              },
              onChange: (elements: readonly ExcalidrawElement[]) => {
                pushSnapshot(elements);
              },
            }),
          );
          rendered = true;
        } catch (err) {
          if (destroyed) return;
          options.onError?.(
            err instanceof Error ? err : new Error("Excalidraw 加载失败"),
          );
        }
      })();
    },

    getDoc(): InkDoc<"excalidraw"> {
      return {
        engine: "excalidraw",
        version: 1,
        // 契约（@tutor/contract inkExcalidrawDataSchema）把 elements 锁为对象数组；
        // ExcalidrawElement 是库的具体接口（无 index signature），结构上就是
        // JSON 对象数组，此转换零运行时开销
        data: {
          scene: {
            elements: [...lastElements] as unknown as Record<string, unknown>[],
          },
        },
        updatedAt,
      };
    },

    async exportPng(): Promise<Blob> {
      const mod = await import("@excalidraw/excalidraw");
      return mod.exportToBlob({
        elements: lastElements as readonly ExcalidrawElement[],
        appState: {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
        },
        mimeType: "image/png",
        files: {},
      });
    },

    undo(): void {
      runWhenReady(() => {
        const prev = undoStack.pop();
        if (!prev || !api) return;
        redoStack.push({ elements: lastElements });
        applying = true;
        api.updateScene({ elements: [...prev.elements] });
        applying = false;
        lastElements = prev.elements;
        notify();
      });
    },

    redo(): void {
      runWhenReady(() => {
        const next = redoStack.pop();
        if (!next || !api) return;
        undoStack.push({ elements: lastElements });
        applying = true;
        api.updateScene({ elements: [...next.elements] });
        applying = false;
        lastElements = next.elements;
        notify();
      });
    },

    clear(): void {
      runWhenReady(() => {
        if (!api) return;
        if (lastElements.length === 0) return;
        undoStack.push({ elements: lastElements });
        redoStack.length = 0;
        applying = true;
        api.updateScene({ elements: [] });
        applying = false;
        lastElements = [];
        notify();
      });
    },

    setTool(next: InkToolConfig): void {
      runWhenReady(() => {
        if (!api) return;
        // 滚动工具位在 Excalidraw 中映射为选择（套索移动）
        const type =
          next.type === "eraser"
            ? "eraser"
            : next.type === "scroll"
              ? "selection"
              : "freedraw";
        api.setActiveTool({ type });
      });
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    load(data: InkDoc): void {
      runWhenReady(() => {
        if (!api) return;
        if (data.engine !== "excalidraw") {
          throw new Error(
            `笔迹数据引擎不匹配：期望 excalidraw，实际 ${data.engine}`,
          );
        }
        void (async () => {
          const mod = await import("@excalidraw/excalidraw");
          const restored = mod.restore(
            { elements: sceneElements(data) },
            null,
            null,
          );
          const elements = restored.elements ?? [];
          undoStack.push({ elements: lastElements });
          redoStack.length = 0;
          applying = true;
          api?.updateScene({ elements });
          applying = false;
          lastElements = elements;
          updatedAt = data.updatedAt;
          const doc = surface.getDoc();
          for (const cb of listeners) cb(doc);
        })();
      });
    },

    onChange(cb: (doc: InkDoc) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    destroy(): void {
      destroyed = true;
      listeners.clear();
      queue.length = 0;
      // 只卸载/移除本适配器创建的节点：容器里可能还有宿主 React 树的
      // 子元素（加载/错误覆盖层），绝不能整容器清空，否则宿主树 removeChild 崩溃。
      // 嵌套 root 的 unmount 不能在宿主树的 commit 阶段同步调用（React 会告警
      // "unmount a root while React was already rendering"），挪到微任务执行；
      // host.remove() 已同步摘除 DOM，视觉无延迟
      const nestedRoot = root;
      root = null;
      if (nestedRoot && rendered) {
        queueMicrotask(() => {
          nestedRoot.unmount();
        });
      }
      host?.remove();
      host = null;
      api = null;
    },
  };

  return surface;
}

/** 从 InkDoc 场景数据中取 elements（不透明 JSON，做最小防御；交给库的
 * restore() 清洗——它本就为"任意外部 JSON"设计） */
function sceneElements(doc: InkDoc): ExcalidrawElement[] {
  if (doc.engine !== "excalidraw") return [];
  const scene = (doc as InkDoc<"excalidraw">).data.scene as {
    elements?: unknown;
  };
  const elements = Array.isArray(scene.elements) ? scene.elements : [];
  return elements as ExcalidrawElement[]; // 语义上就是库导出的元素 JSON
}
