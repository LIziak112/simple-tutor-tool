import type { FunctionPlotOptions } from "function-plot";
import { ImageOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DirectiveProps } from "./types";

/**
 * 媒体指令：::image 块级图片（本地 blobs 路径）、::graph 函数图像。
 * graph 用 function-plot **动态 import 按需加载**（含 d3，体积大，禁首屏打包），
 * 三态齐全：加载中占位 / 渲染失败（带重试）/ 成功。
 */

/**
 * ::image 的 src 归一化：以 "blobs/" 开头（契约上传路径）→ 前缀 "/" 成根相对
 * 伺服 URL——服务端不变量「契约 src 前加 / 即根相对 URL」一一对应；http(s)
 * 绝对 URL 与其他写法原样返回（危险协议已由 sanitize 的 protocols 白名单拦截）。
 */
function normalizeImageSrc(src: string): string {
  return src.startsWith("blobs/") ? `/${src}` : src;
}

/**
 * ::image 块级图片：src 为服务端 blobs 路径（归一化为根相对），width 缺省自适应，
 * alt 缺省「图片」。三态齐全：加载成功 / 加载失败占位（onError 切入，不裂图）/
 * src 缺失提示。
 */
export function ImageDirective({ attrs }: DirectiveProps) {
  const src = attrs.src?.trim();
  // 失败按 src 记录：文档编辑换图（src 变化）后不再命中，无需 effect 重置
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || src.length === 0) {
    return (
      <div className="my-3 flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-3 text-sm text-muted-foreground">
        <ImageOff aria-hidden className="size-4" />
        图片路径缺失（::image 需要 src 属性）
      </div>
    );
  }
  if (failedSrc === src) {
    return (
      <div
        role="alert"
        className="my-3 flex min-h-11 flex-col items-start gap-1 rounded-xl border border-dashed border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground"
      >
        <span className="flex items-center gap-2 text-foreground">
          <ImageOff aria-hidden className="size-4" />
          图片加载失败
        </span>
        <span className="text-xs">
          请把图片与文档一起在导入页选择上传（引用会自动替换为服务器路径）（src：
          {src}）
        </span>
      </div>
    );
  }
  return (
    <img
      src={normalizeImageSrc(src)}
      alt={attrs.alt?.trim() || "图片"}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className="my-3 h-auto max-w-full rounded-xl border border-border"
      style={attrs.width ? { width: attrs.width } : undefined}
    />
  );
}

type GraphState = "loading" | "ready" | "error";

/**
 * 解析 range 属性（如 "-3,3"）为 x 轴区间；非法时返回 null（调用方交给
 * function-plot 自动选取）。T6R.12 起导出共享：question-materials 的图表
 * 静态化与组件渲染同一口径（搬家不抄数）。
 */
export function parseGraphRange(
  range: string | undefined,
): { domain: [number, number] } | null {
  if (!range) return null;
  const parts = range.split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [min, max] = parts as [number, number];
  if (min >= max) return null;
  return { domain: [min, max] };
}

/** ::graph 函数图像：function-plot 动态加载渲染 */
export function GraphDirective({ attrs }: DirectiveProps) {
  const fn = attrs.fn?.trim() ?? "";
  const range = attrs.range?.trim();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<GraphState>("loading");
  /** 幂等的重试触发器：递增即重画（错误态按钮用） */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (fn.length === 0) return;
    let disposed = false;
    const target = hostRef.current;
    if (!target) return;
    setState("loading");
    target.replaceChildren();
    void attempt; // 重试计数：仅用于触发本 effect 重画，不参与绘制参数
    // 按需加载 function-plot（含 d3，禁 CDN、禁首屏打包；失败进错误态可重试）
    import("function-plot")
      .then((functionPlot) => {
        if (disposed || !hostRef.current) return;
        try {
          const options: FunctionPlotOptions = {
            target: hostRef.current,
            width: hostRef.current.clientWidth || 480,
            height: 260,
            data: [{ fn, graphType: "polyline" }],
          };
          // exactOptionalPropertyTypes：xAxis 仅在可解析出区间时携带
          const xAxis = parseGraphRange(range);
          if (xAxis) options.xAxis = xAxis;
          functionPlot.default(options);
          if (!disposed) setState("ready");
        } catch {
          if (!disposed) setState("error");
        }
      })
      .catch(() => {
        if (!disposed) setState("error");
      });
    return () => {
      disposed = true;
    };
  }, [fn, range, attempt]);

  if (fn.length === 0) {
    return (
      <div className="my-3 flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-3 text-sm text-muted-foreground">
        <ImageOff aria-hidden className="size-4" />
        缺少 fn 属性，无法绘制函数图像
      </div>
    );
  }

  return (
    <figure
      data-slot="graph"
      aria-label={`函数图像：${fn}`}
      className="my-3 rounded-xl border border-border bg-card p-3"
    >
      <div ref={hostRef} className="min-h-40" data-graph-canvas />
      {state === "loading" ? (
        <p
          className="py-6 text-center text-sm text-muted-foreground"
          role="status"
        >
          函数图像加载中…
        </p>
      ) : null}
      {state === "error" ? (
        <div
          className="flex flex-col items-center gap-2 py-4 text-sm"
          role="alert"
        >
          <p className="text-destructive">
            函数图像渲染失败，请检查 fn 表达式书写。
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border px-4 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw aria-hidden className="size-4" />
            重新加载
          </button>
        </div>
      ) : null}
    </figure>
  );
}
