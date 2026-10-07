import type { GraphFigureSpec } from "@tutor/md-dsl";
import { parseGraphRange } from "../markdown/graph-range";

/**
 * 授权静态题目素材导出模块（T6R.12；T6R.13 起纯函数部分移入
 * @tutor/md-dsl 的 v2/static-material.ts——服务端单题 review-pack 与本模块
 * 共用同一实现，此处 re-export 保持既有 import 路径不变）。
 *
 * 本文件保留的浏览器侧职责：
 * - renderGraphFigurePng：::graph 图表 → PNG（function-plot → SVG → Canvas，
 *   依赖 DOM，服务端不可用；显式失败语义，无 DOM 截图兜底）；
 * - 纯函数 API 的 re-export（buildStaticQuestionMaterial / 类型 / 常量）。
 */

export type {
  GraphFigureSpec,
  QuestionMaterialRole,
  StaticQuestionMaterial,
  StaticQuestionMaterialInput,
} from "@tutor/md-dsl";
export {
  buildStaticQuestionMaterial,
  STATIC_INTERACTION_NOTE,
} from "@tutor/md-dsl";

// ---------- ::graph 图表静态化（显式失败语义，无 DOM 截图兜底） ----------

/** 图表静态化结果：ok=true 携带 PNG dataUrl；ok=false 携带可读原因 */
export type GraphFigureRenderResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 把 ::graph 图表渲染为 PNG dataUrl（function-plot → SVG → Canvas）：
 * - host 由调用方提供（离屏容器；本函数只填充与读取，不挂载/不销毁）；
 * - 任何一步失败（function-plot 加载失败、SVG 缺失、Canvas 不可用、编码
 *   失败）返回 ok=false + 原因——**不伪造图片、不退回 DOM 截图**；调用方
 *   按「图表缺失」显式标注（方案 §9.3：缺必要图形可导出不完整材料）。
 */
export async function renderGraphFigurePng(
  host: HTMLElement,
  figure: GraphFigureSpec,
  pixelWidth = 480,
  pixelHeight = 260,
): Promise<GraphFigureRenderResult> {
  try {
    const functionPlot = (await import("function-plot")).default;
    host.replaceChildren();
    host.style.width = `${pixelWidth}px`;
    const options = {
      target: host,
      width: pixelWidth,
      height: pixelHeight,
      data: [{ fn: figure.fn, graphType: "polyline" as const }],
    };
    const xAxis = parseGraphRange(figure.range);
    functionPlot(xAxis === null ? options : { ...options, xAxis });
    const svg = host.querySelector("svg");
    if (svg === null) {
      return { ok: false, reason: "图表渲染未产出 SVG" };
    }
    const xml = new XMLSerializer().serializeToString(svg);
    const svgUrl = URL.createObjectURL(
      new Blob([xml], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("SVG 图像加载失败"));
        image.src = svgUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext("2d");
      if (context === null) {
        return { ok: false, reason: "画布不可用（Canvas 2D 上下文缺失）" };
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/png")) {
        return { ok: false, reason: "PNG 编码失败（空输出）" };
      }
      return { ok: true, dataUrl };
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `图表静态化失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
