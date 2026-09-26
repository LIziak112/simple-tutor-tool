/**
 * 坐标归一化（T2.7，架构 §5.4.1 数据层第 1 条）。
 *
 * 存储时把容器 CSS 像素坐标统一缩放到逻辑宽度 1000；重绘时按当前容器宽度反算。
 * 纵向用同一比例缩放（等比），横竖屏旋转、换设备才能无损重绘。
 * 归一化结果保留 2 位小数（1000 宽下约 0.1px 精度），反算不额外取整——
 * 这样 normalize → denormalize → normalize 可严格还原（有单测保证）。
 */
import { INK_LOGICAL_WIDTH } from "./types.ts";

/** 保留 2 位小数（避免浮点尾数进入存储与深比较） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** CSS 像素 → 逻辑坐标（按容器宽度等比缩放到 1000） */
export function toLogical(cssWidth: number, value: number): number {
  return round2((value / cssWidth) * INK_LOGICAL_WIDTH);
}

/** 逻辑坐标 → CSS 像素（按容器宽度从 1000 反算，不取整以保留精度） */
export function fromLogical(cssWidth: number, value: number): number {
  return (value / INK_LOGICAL_WIDTH) * cssWidth;
}

/** 一对坐标的归一化/反算便捷封装 */
export function toLogicalPoint(
  cssWidth: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: toLogical(cssWidth, x), y: toLogical(cssWidth, y) };
}

export function fromLogicalPoint(
  cssWidth: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: fromLogical(cssWidth, x), y: fromLogical(cssWidth, y) };
}
