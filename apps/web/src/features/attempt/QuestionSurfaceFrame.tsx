import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

let pixelGrid: { ratio: number; zoom: number } | undefined;
export const StableQuestionPixelGridContext = createContext(true);

/** 原生系统缩放会把 1px 边框取整为 0.8px 等值；在整数网格排版，再抵消视觉缩放。 */
function logicalPixelZoom(): number {
  const ratio = window.devicePixelRatio;
  if (pixelGrid?.ratio === ratio) return pixelGrid.zoom;
  let zoom = 1;
  if (typeof CSS !== "undefined" && CSS.supports("zoom", "0.8")) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;border:1px solid;padding:0;";
    document.body.append(probe);
    const border = Number.parseFloat(getComputedStyle(probe).borderTopWidth);
    probe.remove();
    if (border > 0 && border < 1) {
      const physical = border * ratio;
      const pixels = Math.round(physical);
      zoom =
        pixels > 0 && Math.abs(physical - pixels) < 0.0001 ? 1 / ratio : border;
    }
  }
  pixelGrid = { ratio, zoom };
  return zoom;
}

/** 正常题面与导出副本共用；只改变像素取整环境，不改变视觉尺寸和笔迹坐标。 */
export function QuestionSurfaceFrame({ children }: { children: ReactNode }) {
  const stablePixels = useContext(StableQuestionPixelGridContext);
  const host = useRef<HTMLDivElement>(null);
  const logical = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ zoom: 1, width: 0, height: 0 });
  const measure = useCallback(() => {
    const outer = host.current;
    const inner = logical.current;
    if (!outer || !inner) return;
    const zoom = stablePixels ? logicalPixelZoom() : 1;
    if (zoom === 1) {
      setMetrics((previous) =>
        previous.zoom === 1 ? previous : { zoom: 1, width: 0, height: 0 },
      );
      return;
    }
    const scale = Number(
      outer.closest<HTMLElement>("[data-annotation-scale]")?.dataset
        .annotationScale ?? 1,
    );
    if (!Number.isFinite(scale) || scale <= 0) return;
    const rounded = (value: number) => Math.round((value / scale) * 64) / 64;
    // 已保存稿与导出副本有权威逻辑宽度；不能从经过原生像素取整的外框反推。
    const fixedFrame = outer.closest<HTMLElement>(
      '[data-slot="annotation-logical-frame"], [data-slot="question-base-host"]',
    );
    const fixedWidth = Number.parseFloat(fixedFrame?.style.width ?? "");
    const next = {
      zoom,
      width:
        Number.isFinite(fixedWidth) && fixedWidth > 0
          ? fixedWidth
          : rounded(outer.getBoundingClientRect().width),
      height: rounded(inner.getBoundingClientRect().height),
    };
    if (next.width <= 0) {
      // 隐藏题卡也先记录像素网格，以便显示时的 ResizeObserver 能启动适配。
      setMetrics((previous) =>
        previous.zoom === zoom && previous.width === 0
          ? previous
          : { zoom, width: 0, height: 0 },
      );
      return;
    }
    setMetrics((previous) =>
      previous.zoom === next.zoom &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    );
  }, [stablePixels]);
  useLayoutEffect(() => {
    measure();
    const observer = metrics.zoom !== 1 ? new ResizeObserver(measure) : null;
    if (host.current) observer?.observe(host.current);
    if (logical.current) observer?.observe(logical.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, metrics.zoom]);
  // 首次启用 zoom 或改列宽后，按补偿后的实际高度保留文档流占位。
  useLayoutEffect(() => {
    if (metrics.zoom !== 1 && metrics.width > 0) measure();
  }, [measure, metrics.zoom, metrics.width]);
  const adjusted = metrics.zoom !== 1 && metrics.width > 0;
  return (
    <div
      ref={host}
      className="w-full min-w-0"
      data-slot="question-surface-frame"
      data-pixel-grid={stablePixels ? "stable" : "native"}
      style={adjusted ? { height: metrics.height } : undefined}
    >
      <div
        ref={logical}
        style={
          adjusted
            ? {
                width: metrics.width,
                zoom: metrics.zoom,
                transform: `scale(${1 / metrics.zoom})`,
                transformOrigin: "top left",
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
