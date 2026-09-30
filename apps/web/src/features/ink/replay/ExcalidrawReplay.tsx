/**
 * 回放的 excalidraw 渲染桥（T3.3，D12）。
 *
 * excalidraw 元素无点级时间戳（契约只锁 elements 为对象数组）：按元素顺序
 * 匀速近似——每个元素在其时间槽起点整体出现（freedraw 按点数加权，见
 * model.ts）。渲染完全复用 Excalidraw 库（restore + updateScene，与引擎层
 * excalidraw-adapter 同款手法），自己不画任何笔迹：
 * - 库与样式只在挂载时动态 import（独立 chunk 不进主包，ui-conventions）；
 * - 元素先整体 restore() 清洗一次，之后每帧 updateScene 前缀切片——
 *   帧只在可见个数变化时切换（≤ 元素数次），成本可控；
 * - viewModeEnabled 只读查看（保留缩放/平移供老师端检查笔迹）。
 *
 * jsdom 无法可靠渲染真实 canvas，本组件不做单测（InkReplay 测试中 mock 本模块）。
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { cn } from "cn";
import { useEffect, useMemo, useState } from "react";

/** 本站静态资源目录（与 excalidraw-adapter 一致：禁 CDN，vite 插件提供） */
const ASSET_PATH = "/excalidraw-assets/";

/** 动态导入的库模块类型（type-only，不产生运行时代码） */
type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

export function ExcalidrawReplay({
  elements,
  visibleElements,
  className,
}: {
  /** 库原生场景元素（模型持有，顺序 = 生成顺序） */
  elements: Record<string, unknown>[];
  /** frameAt 产出的已出现元素个数 */
  visibleElements: number;
  className?: string;
}) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  // 懒加载库与样式（资源指向本站目录，禁止 CDN）
  useEffect(() => {
    let alive = true;
    window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;
    void (async () => {
      try {
        await import("@excalidraw/excalidraw/index.css");
        const imported = await import("@excalidraw/excalidraw");
        if (alive) setMod(imported);
      } catch {
        if (alive) setLoadError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 元素整体 restore() 一次（库为任意外部 JSON 设计的清洗入口，异常时降级提示）
  const restored = useMemo(() => {
    if (!mod) return null;
    try {
      return (
        mod.restore({ elements: elements as ExcalidrawElement[] }, null, null)
          .elements ?? []
      );
    } catch {
      return null;
    }
  }, [mod, elements]);

  // 可见个数变化 → 前缀切片送入库渲染（只在切换帧时触发）
  useEffect(() => {
    if (!api || !restored) return;
    api.updateScene({ elements: restored.slice(0, visibleElements) });
  }, [api, restored, visibleElements]);

  if (loadError || (mod && restored === null)) {
    return (
      <div
        className={cn(
          "flex min-h-11 items-center justify-center px-3 text-sm text-muted-foreground",
          className,
        )}
      >
        {loadError
          ? "回放组件加载失败，请刷新重试"
          : "回放数据无法解析，请刷新重试"}
      </div>
    );
  }
  if (!mod || !restored) {
    return (
      <div
        className={cn(
          "flex min-h-11 items-center justify-center px-3 text-sm text-muted-foreground",
          className,
        )}
      >
        正在加载回放组件…
      </div>
    );
  }
  const Excalidraw = mod.Excalidraw;
  return (
    <div className={cn("h-full w-full overflow-hidden", className)}>
      <Excalidraw
        langCode="zh-CN"
        theme="light"
        name="笔迹回放"
        viewModeEnabled
        initialData={{
          elements: restored.slice(0, visibleElements),
          appState: { viewBackgroundColor: "#ffffff" },
        }}
        excalidrawAPI={(instance: ExcalidrawImperativeAPI) => setApi(instance)}
      />
    </div>
  );
}
