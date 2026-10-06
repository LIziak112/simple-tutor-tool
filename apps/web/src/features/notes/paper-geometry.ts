/**
 * 新草稿纸张几何工具（T6R.7，方案 §4.3「逻辑坐标与高度」）。
 *
 * 口径：
 * - 逻辑宽恒 INK_LOGICAL_WIDTH（1000）——本模块不定义第二个宽度常量；
 * - 纸高以**逻辑单位**持久化（NoteDoc.paperHeightLogical），CSS 显示高度
 *   = paperHeightLogical × scale **分离派生**（禁止 CSS 高度混入逻辑坐标）；
 * - resize/旋转只改变 scale：笔画存逻辑坐标 ⇒ 完整笔迹（含线宽包围盒）
 *   永远在纸内，不因布局变化被裁切；「首次默认高度不随横竖屏反复重写」
 *   由逻辑高只增不减（自动加高）保证；
 * - 自动加高沿用「距底 72 CSS px 触发」的体验，触发判定在 CSS 口径、
 *   **增长量换算成逻辑单位**（240 CSS px → 240/scale）；拖高同样换算；
 * - 缩小（用户拖高/回收）不得低于全部笔画包围盒（**含半线宽**，复用
 *   engine/bounds 的 strokeBounds——与渲染器同一份点级折叠）+ 一格留白；
 * - **load 高度权威**：载入文档直接采用正文持久化高度，不做增长/收缩
 *   重算——load 不触发 dirty/编辑计数（高度变化只由用户操作/书写产生）。
 *
 * 供 T6R.9 的 NoteLayer 使用；**不改 InkPad 旧自动加高行为**（其按 CSS px
 * 直增，属旧作答链路兼容语义）。纯函数、无 DOM。
 */
import { NOTE_PAPER_HEIGHT_MAX, type NoteDoc } from "@tutor/contract";
import { strokeBounds } from "@/features/ink/engine/bounds.ts";
import {
  NOTE_PAPER_GRID_SPACING_LOGICAL,
  PAPER_GROW_STEP_CSS_PX,
  PAPER_GROW_TRIGGER_CSS_PX,
} from "@/features/ink/engine/paper-style.ts";
import {
  fromLogical,
  toLogical,
} from "@/features/ink/engine/normalize.ts";
import {
  INK_LOGICAL_WIDTH,
  type InkStroke,
} from "@/features/ink/engine/types.ts";

// 加高 UX 常量与 InkPad 同源（engine/paper-style，复审①）：旧作答链路
// （CSS px 直增）与新草稿链路（换算逻辑单位）共用同一组数值。
export {
  PAPER_GROW_STEP_CSS_PX,
  PAPER_GROW_TRIGGER_CSS_PX,
} from "@/features/ink/engine/paper-style.ts";

/**
 * 缩小下限留白（逻辑单位）：**派生自格线间距**（一格留白，复审③）——
 * 纸面节奏（格距）调整时留白随之同步，不另立数值。
 */
export const NOTE_PAPER_SHRINK_MARGIN_LOGICAL = NOTE_PAPER_GRID_SPACING_LOGICAL;

/** 显示比例：scale = paperCssWidth / 1000（方案 §4.3；比例本身，点位换算用 normalize） */
export function paperScale(cssWidth: number): number {
  return cssWidth / INK_LOGICAL_WIDTH;
}

/**
 * CSS 纸高 = paperHeightLogical × scale（最小 1，防零高画布）。换算复用
 * engine/normalize 的 fromLogical（复审②：逻辑↔CSS 的比例式只有一份），
 * 本函数只保留取整/防零壳。
 */
export function paperCssHeight(
  paperHeightLogical: number,
  cssWidth: number,
): number {
  return Math.max(1, Math.round(fromLogical(cssWidth, paperHeightLogical)));
}

/**
 * 拖高换算：CSS 高 → 逻辑高（paperCssHeight 的逆运算，最小 1）。复用
 * normalize 的 toLogical（round2 保精度）再取整到逻辑整数——与
 * paperCssHeight 的直取整在 .495/.505 级病态边界可能有 ±1 差异，锁定值
 * 见测试；拖高是冷路径，精度损失无感。
 */
export function cssHeightToLogical(
  cssHeight: number,
  cssWidth: number,
): number {
  return Math.max(1, Math.round(toLogical(cssWidth, cssHeight)));
}

/**
 * 自动加高：最后一笔最低点距纸底不足 PAPER_GROW_TRIGGER_CSS_PX（CSS 口径）
 * 时，增高一步（PAPER_GROW_STEP_CSS_PX 换算成逻辑单位），封顶
 * NOTE_PAPER_HEIGHT_MAX。无需增高或已到顶返回 null（调用方不落库 ⇒ 不触发
 * dirty）。@param strokeMaxYLogical 建议传含半线宽的包围盒底
 * （strokesBottomLogical / strokeBounds），粗笔贴近底边同样触发。
 */
export function grownPaperHeight(input: {
  paperHeightLogical: number;
  cssWidth: number;
  strokeMaxYLogical: number;
}): number | null {
  const { paperHeightLogical, cssWidth, strokeMaxYLogical } = input;
  if (paperHeightLogical >= NOTE_PAPER_HEIGHT_MAX) return null;
  const scale = paperScale(cssWidth);
  const cssBottom = paperHeightLogical * scale;
  const strokeBottomCss = strokeMaxYLogical * scale;
  if (strokeBottomCss <= cssBottom - PAPER_GROW_TRIGGER_CSS_PX) return null;
  const growLogical = PAPER_GROW_STEP_CSS_PX / scale;
  return Math.min(
    NOTE_PAPER_HEIGHT_MAX,
    Math.round(paperHeightLogical + growLogical),
  );
}

/** 全部笔画的最低点（逻辑坐标，**含每笔半线宽**）；空稿返回 null */
export function strokesBottomLogical(
  strokes: readonly InkStroke[],
): number | null {
  let bottom: number | null = null;
  for (const s of strokes) {
    const bb = strokeBounds(s, s.weight / 2);
    if (bb && (bottom === null || bb.maxY > bottom)) bottom = bb.maxY;
  }
  return bottom;
}

/**
 * 缩小钳制：用户拖高/收缩后的目标纸高不得低于全部笔画包围盒底（含半线宽）
 * + 留白，也不超过 NOTE_PAPER_HEIGHT_MAX。空稿下限 1（无笔迹约束）。
 * 高于下限的值原样返回（取整）。
 */
export function clampedShrinkPaperHeight(
  proposed: number,
  strokes: readonly InkStroke[],
): number {
  const bottom = strokesBottomLogical(strokes);
  const min =
    bottom === null ? 1 : Math.ceil(bottom + NOTE_PAPER_SHRINK_MARGIN_LOGICAL);
  return Math.min(
    NOTE_PAPER_HEIGHT_MAX,
    Math.max(min, Math.max(1, Math.round(proposed))),
  );
}

/**
 * load 高度权威：直接采用正文持久化高度（调用方经 noteDocSchema.parse
 * 物化默认值后传入）。不做增长/收缩重算——**load 不触发 dirty/编辑计数**，
 * 高度变化只由书写（自动加高）或用户拖高产生。正文高度低于笔画包围盒时
 * 保持正文值（契约允许 y 与纸高解耦；渲染层按纸界裁剪的策略不变，钳制
 * 只发生在用户主动操作时）。
 */
export function paperHeightOnLoad(
  doc: Pick<NoteDoc, "paperHeightLogical">,
): number {
  return doc.paperHeightLogical;
}
