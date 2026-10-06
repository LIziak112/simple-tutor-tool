/**
 * 纸张常量集与屏幕端 CSS（T6R.7，方案 §4.3）。
 *
 * 背景常量**上移自** features/notes/render-note.ts（其注释预留的「T6R.7
 * 落地时上移 engine 层共用」锚点）：render-note（PNG）与本模块（屏幕端
 * CSS）从同一组常量生成，数值改动只发生在此处。上移不改值 ⇒ PNG 像素
 * 输出不变，不递增契约 NOTE_RENDER_VERSION。
 *
 * 加高 UX 常量（触发 72 / 步长 240 CSS px）自 InkPad 收拢至此（复审①）：
 * 旧作答组件（InkPad，CSS px 直增）与新草稿几何（notes/paper-geometry，
 * 换算逻辑单位）同源引用——数值改动一处生效，两链路体验一致。
 *
 * ⚠️ 全部数值为**暂定值**（T6R.1 真机定标后修订）；改任何影响 PNG 像素
 * 输出的值必须递增 NOTE_RENDER_VERSION（见 packages/contract/src/note.ts）。
 */
import type { NoteBackground } from "@tutor/contract";
import { INK_LOGICAL_WIDTH } from "./types.ts";

/** 纸张格线/横线间距（逻辑单位）。屏幕、PNG、历史回看共用（方案 §4.3） */
export const NOTE_PAPER_GRID_SPACING_LOGICAL = 40;

/** 格线/横线线宽（1px 细线；PNG 描边与 CSS 渐变带同宽） */
export const NOTE_PAPER_LINE_WIDTH_PX = 1;

/** 格线/横线颜色（画进 PNG 的实际描边色，非 CSS 调色板变量） */
export const NOTE_PAPER_LINE_COLOR = "#cbd5e1";

/** 纸张底色：PNG 与屏幕统一白底（教师/AI 查看口径，同旧 exportPng） */
export const NOTE_PAPER_BG_COLOR = "#ffffff";

/** 自动加高触发：最后一笔距纸底不足该 CSS px 值时增高（方案 §4.3 沿用旧体验） */
export const PAPER_GROW_TRIGGER_CSS_PX = 72;

/** 自动加高的步长（CSS px 口径；新草稿链路落库前换算成逻辑单位） */
export const PAPER_GROW_STEP_CSS_PX = 240;

/**
 * 屏幕端纸张背景的 background-image 值。
 *
 * 口径注释（与 PNG 输出一致性的边界）：
 * - 间距/颜色/1px 线宽与 PNG（render-note 的 paintPaperBackground）**同源
 *   常量**，间距按容器宽换算 S = 40 × cssWidth/1000，resize 时由适配器重设；
 * - PNG 里线条以 lineWidth=1 描在格线整数倍坐标上（中心 ±0.5px），CSS 渐变
 *   带为 [S-1px, S)——两侧 ≤1px 的栅格化相位差属屏幕近似；**派生图（PNG）
 *   是权威输出口径**（NOTE_RENDER_VERSION 只管辖 PNG），屏幕背景仅为编辑
 *   时的视觉对齐；
 * - white 返回 "none"：旧手写作答组件不设置任何 canvas 背景样式（零变化）；
 * - 间距换算后不足线宽（极窄容器/零宽）返回 "none"，不生成非法渐变。
 */
export function paperBackgroundCss(
  background: NoteBackground,
  cssWidth: number,
): string {
  if (background === "white") return "none";
  const spacingCss =
    (NOTE_PAPER_GRID_SPACING_LOGICAL * cssWidth) / INK_LOGICAL_WIDTH;
  if (!(spacingCss > NOTE_PAPER_LINE_WIDTH_PX)) return "none";
  const w = NOTE_PAPER_LINE_WIDTH_PX;
  const color = NOTE_PAPER_LINE_COLOR;
  // 线带 [S-w, S)：停靠点直接输出换算后的数值（含小数 px），不用 calc()——
  // 与 PNG「线落在格线整数倍上」同一节奏（首线在 S 而非 0，与渲染器
  // firstAfter 语义一致——纸顶边缘不画线）
  const band = (dir: "bottom" | "right"): string => {
    const start = spacingCss - w;
    return `repeating-linear-gradient(to ${dir}, transparent 0, transparent ${start}px, ${color} ${start}px, ${color} ${spacingCss}px)`;
  };
  if (background === "line") return band("bottom");
  return `${band("right")}, ${band("bottom")}`;
}
