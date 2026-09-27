import { describe, expect, it } from "vitest";
import { fromLogical, toLogical, toLogicalPoint } from "./normalize.ts";
import { INK_LOGICAL_WIDTH } from "./types.ts";

/** 坐标归一化测试（验收项：坐标归一化） */
describe("坐标归一化（逻辑宽 1000）", () => {
  it("CSS 像素 → 逻辑坐标按宽度等比缩放", () => {
    // 容器宽 800：一半宽度 → 逻辑 500
    expect(toLogical(800, 400)).toBe(500);
    // 容器宽 1024：四分之一宽度 → 逻辑 250
    expect(toLogical(1024, 256)).toBe(250);
    // 纵向同比例（保持纵横比，旋转后比例才正确）
    expect(toLogical(800, 123)).toBeCloseTo(153.75, 2);
  });

  it("逻辑坐标 → 按另一宽度反算数值正确", () => {
    // 宽 800 存下的点，在宽 1024 的容器里反算：x_css = x_norm * 1024 / 1000
    const xNorm = toLogical(800, 400); // 500
    expect(fromLogical(1024, xNorm)).toBeCloseTo(512, 6);
    const yNorm = toLogical(800, 300); // 375
    expect(fromLogical(1024, yNorm)).toBeCloseTo(384, 6);
  });

  it("归一化保留 2 位小数（存储精度）", () => {
    expect(toLogical(1024, 1)).toBe(0.98); // 1000/1024 ≈ 0.9766 → 0.98
    expect(toLogical(3, 1)).toBeCloseTo(333.33, 2);
  });

  it("normalize → denormalize → normalize 严格还原（往返无损）", () => {
    // 关键性质：反算后再次归一化得到同一个存储值（round2 幂等）
    for (const cssWidth of [320, 800, 1024, 1366]) {
      for (const v of [0, 1, 7.3, cssWidth / 2, cssWidth - 0.5, cssWidth]) {
        const n = toLogical(cssWidth, v);
        expect(toLogical(cssWidth, fromLogical(cssWidth, n))).toBe(n);
      }
    }
  });

  it("换宽度往返：w1 归一化后按 w2 反算 = 等比重绘坐标", () => {
    const w1 = 744; // iPad 竖屏答题区近似宽
    const w2 = 1024; // 横屏近似宽
    const x = 233.5;
    const y = 500;
    const n = toLogicalPoint(w1, x, y);
    const back = fromLogicalWidth(w2, n.x);
    // 归一化保留 2 位小数（逻辑宽 1000），反算到 w2 后误差上界约 0.005 * w2/1000
    expect(back).toBeCloseTo((x * w2) / w1, 1);
  });
});

function fromLogicalWidth(w: number, v: number): number {
  return (v / INK_LOGICAL_WIDTH) * w;
}
