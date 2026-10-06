import { describe, expect, it } from "vitest";
import { NOTE_PAPER_GRID_SPACING_LOGICAL } from "@/features/ink/engine/paper-style.ts";
import type { InkStroke } from "@/features/ink/engine/types.ts";
import {
  clampedShrinkPaperHeight,
  cssHeightToLogical,
  grownPaperHeight,
  NOTE_PAPER_SHRINK_MARGIN_LOGICAL,
  PAPER_GROW_STEP_CSS_PX,
  PAPER_GROW_TRIGGER_CSS_PX,
  paperCssHeight,
  paperScale,
  strokesBottomLogical,
} from "./paper-geometry.ts";

/**
 * 新草稿纸张几何（T6R.7，方案 §4.3）：逻辑宽 1000 恒定；纸高以**逻辑单位**
 * 持久化，CSS 显示高度 = paperHeightLogical × scale 分离派生；自动加高的
 * 触发（距底 72 CSS px）与增长量（240 CSS px）统一换算逻辑单位；缩小不得
 * 低于全部笔画包围盒（含线宽）+ 留白；resize/旋转按逻辑坐标保完整笔迹。
 * 供 T6R.9 的 NoteLayer 使用；**不改 InkPad 旧自动加高行为**（其按 CSS px）。
 */

function stroke(points: Array<[number, number]>, weight = 4): InkStroke {
  return {
    tool: "pen",
    color: "#1f2328",
    weight,
    points: points.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 10 })),
  };
}

describe("paper-geometry：比例与 CSS 高度派生", () => {
  it("scale = cssWidth/1000；CSS 高 = paperHeightLogical × scale（旋转只变比例不变逻辑高）", () => {
    expect(paperScale(500)).toBe(0.5);
    expect(paperCssHeight(800, 500)).toBe(400);
    // 旋转：容器宽 500 → 700，同一逻辑稿 CSS 高按新比例派生（逻辑高不动）
    expect(paperCssHeight(800, 700)).toBe(560);
    // 派生不变量：笔画逻辑 y ≤ 纸高 ⇒ CSS y ≤ CSS 高（不裁切）
    const maxYLogical = 790;
    expect(maxYLogical * paperScale(700)).toBeLessThanOrEqual(
      paperCssHeight(800, 700),
    );
  });

  it("CSS 高最小 1（防零高画布）", () => {
    expect(paperCssHeight(1, 500)).toBe(1);
  });

  it("拖高换算：CSS → 逻辑（与派生互逆，四舍五入）", () => {
    expect(cssHeightToLogical(400, 500)).toBe(800);
    expect(cssHeightToLogical(300, 300)).toBe(1000);
    expect(cssHeightToLogical(1, 500)).toBe(2); // 1/0.5=2
    expect(cssHeightToLogical(0.4, 500)).toBe(1); // 最小 1
  });

  it("常量口径：触发 72/步长 240 CSS px（与旧 InkPad 同源，经 engine/paper-style）；留白派生自格距", () => {
    expect(PAPER_GROW_TRIGGER_CSS_PX).toBe(72);
    expect(PAPER_GROW_STEP_CSS_PX).toBe(240);
    // 复审③：留白不再立数值，恒等于一格线距（格距定标时留白随之同步）
    expect(NOTE_PAPER_SHRINK_MARGIN_LOGICAL).toBe(
      NOTE_PAPER_GRID_SPACING_LOGICAL,
    );
  });
});

describe("paper-geometry：自动加高（触发与增长量均换算逻辑单位）", () => {
  it("距底不足 72 CSS px 时增高一步（240 CSS px 换算成逻辑）", () => {
    // 容器 500 宽：scale 0.5；纸 800 逻辑 = 400 CSS；触发线 400-72=328 CSS = 656 逻辑
    expect(
      grownPaperHeight({
        paperHeightLogical: 800,
        cssWidth: 500,
        strokeMaxYLogical: 655,
      }),
    ).toBeNull();
    expect(
      grownPaperHeight({
        paperHeightLogical: 800,
        cssWidth: 500,
        strokeMaxYLogical: 656.01,
      }),
    ).toBe(800 + 240 / 0.5); // 1280
  });

  it("封顶 3000：到顶后不再增长（返回 null）", () => {
    expect(
      grownPaperHeight({
        paperHeightLogical: 2900,
        cssWidth: 500,
        strokeMaxYLogical: 2899,
      }),
    ).toBe(3000);
    expect(
      grownPaperHeight({
        paperHeightLogical: 3000,
        cssWidth: 500,
        strokeMaxYLogical: 2999,
      }),
    ).toBeNull();
  });

  it("零宽/负宽护栏（复审⑤）：grow 返回原高、css→logical 返回 1（优雅降级不抛错）", () => {
    expect(
      grownPaperHeight({
        paperHeightLogical: 800,
        cssWidth: 0,
        strokeMaxYLogical: 799,
      }),
    ).toBe(800);
    expect(
      grownPaperHeight({
        paperHeightLogical: 800,
        cssWidth: -30,
        strokeMaxYLogical: 799,
      }),
    ).toBe(800);
    expect(cssHeightToLogical(400, 0)).toBe(1);
    expect(cssHeightToLogical(400, -5)).toBe(1);
  });
});

describe("paper-geometry：缩小钳制（包围盒含线宽 + 留白）", () => {
  it("笔画最低点（含半线宽）+ 留白 40 是缩小下限；空稿可缩至 1", () => {
    const strokes = [
      stroke(
        [
          [100, 100],
          [400, 600],
        ],
        16,
      ),
    ]; // 半线宽 8 → 底 608
    const min = 608 + NOTE_PAPER_SHRINK_MARGIN_LOGICAL; // 648
    expect(clampedShrinkPaperHeight(500, strokes)).toBe(min);
    expect(clampedShrinkPaperHeight(700, strokes)).toBe(700); // 高于下限原样通过
    expect(clampedShrinkPaperHeight(1, [])).toBe(1);
  });

  it("多笔取并集最低点；上限仍 3000", () => {
    const strokes = [
      stroke([
        [0, 0],
        [10, 10],
      ]),
      stroke(
        [
          [50, 1200],
          [60, 1250],
        ],
        6,
      ), // 半线宽 3 → 底 1253
    ];
    expect(clampedShrinkPaperHeight(100, strokes)).toBe(1253 + 40);
    expect(clampedShrinkPaperHeight(9999, strokes)).toBe(3000);
  });

  it("strokesBottomLogical：含线宽的最低点（供 UI 显示剩余空间）", () => {
    expect(
      strokesBottomLogical([
        stroke(
          [
            [10, 100],
            [20, 200],
          ],
          10,
        ),
      ]),
    ).toBe(205);
    expect(strokesBottomLogical([])).toBeNull();
  });
});

// load 高度权威（复审⑥）：恒等函数已删——T6R.9 NoteLayer 载入时直接读
// doc.paperHeightLogical（经 noteDocSchema.parse 物化默认值），不调用本
// 模块重算；约定见 paper-geometry.ts 模块头「load 高度权威」条目。
// 「load 不触发 dirty/编辑计数」的行为锚点在 atrament-adapter.test
// （load 全程 reason=load）与 InkChangeReason 契约（surface.ts）。
