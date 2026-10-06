import type { NoteDoc } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import type { InkStroke } from "@/features/ink/engine/types.ts";
import { INK_LOGICAL_WIDTH } from "@/features/ink/engine/types.ts";
import {
  clampedShrinkPaperHeight,
  cssHeightToLogical,
  grownPaperHeight,
  NOTE_PAPER_SHRINK_MARGIN_LOGICAL,
  PAPER_GROW_STEP_CSS_PX,
  PAPER_GROW_TRIGGER_CSS_PX,
  paperCssHeight,
  paperHeightOnLoad,
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

  it("常量口径：触发 72 CSS px、步长 240 CSS px（与旧 InkPad 体验一致），留白一格线距", () => {
    expect(PAPER_GROW_TRIGGER_CSS_PX).toBe(72);
    expect(PAPER_GROW_STEP_CSS_PX).toBe(240);
    expect(NOTE_PAPER_SHRINK_MARGIN_LOGICAL).toBe(40);
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

describe("paper-geometry：load 高度权威（不触发 dirty/编辑计数）", () => {
  it("载入文档直接采用正文持久化高度（已物化默认值），不做增长/收缩重算", () => {
    const doc = {
      version: 1,
      ink: {
        width: INK_LOGICAL_WIDTH,
        strokes: [
          stroke([
            [0, 1100],
            [100, 1150],
          ]),
        ],
      },
      paperHeightLogical: 1200,
      background: "grid",
    } as NoteDoc;
    // 即使最后一笔贴近底部（自动加高口径下会触发），load 也不重算高度——
    // 高度由正文持久化值权威给出，load 不触发 dirty/编辑计数
    expect(paperHeightOnLoad(doc)).toBe(1200);
    // 高度低于笔画包围盒的防御口径：保持正文值（渲染层按纸界裁剪的策略不变，
    // 契约允许 y≤3000 与纸高解耦）；钳制只发生在用户主动拖高/缩小时
    expect(paperHeightOnLoad({ ...doc, paperHeightLogical: 600 })).toBe(600);
  });
});
