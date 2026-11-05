import { describe, expect, it } from "vitest";
import {
  compatibleSurfaceEvidence,
  normalizeSurfaceFont,
} from "./annotation-layout-compatibility";

describe("跨内核布局证据", () => {
  it("规范化字体引号和浮点噪声，但保留真正的字体和字距变化", () => {
    expect(
      normalizeSurfaceFont([
        '"Geist Variable", sans-serif',
        "19.36px",
        "400",
        "23.232px",
        "normal",
      ]),
    ).toEqual(
      normalizeSurfaceFont([
        "Geist Variable, sans-serif",
        "19.360001px",
        "400",
        "23.232002px",
        "normal",
      ]),
    );
    expect(
      normalizeSurfaceFont(["serif", "16px", "400", "28px", "0.25px"]),
    ).not.toEqual(
      normalizeSurfaceFont(["sans-serif", "16px", "400", "28px", "normal"]),
    );
  });
  it("允许 10px 内公式基线差异，拒绝换行、块顺序和明显偏移", () => {
    const saved = {
      blocks: [{ tag: "P", x: 0, y: 0, width: 300, height: 28 }],
      fonts: [
        normalizeSurfaceFont(["sans-serif", "16px", "400", "28px", "normal"]),
      ],
      textRects: [{ x: 0, y: 2, width: 180, height: 22 }],
    };
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        textRects: [{ x: 0, y: 2.5, width: 180.015625, height: 22 }],
      }),
    ).toBe(true);
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        textRects: [
          { x: 0, y: 2, width: 90, height: 22 },
          { x: 0, y: 30, width: 90, height: 22 },
        ],
      }),
    ).toBe(false);
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        blocks: [{ tag: "LABEL", x: 0, y: 0, width: 300, height: 28 }],
      }),
    ).toBe(false);
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        textRects: [{ x: 0, y: 12.001, width: 180, height: 22 }],
      }),
    ).toBe(false);
  });

  const saved = {
    blocks: [
      { tag: "P", node: "stem/p/0", x: 20, y: 20, width: 300, height: 28 },
    ],
    fonts: [
      normalizeSurfaceFont(["sans-serif", "16px", "400", "28px", "normal"]),
    ],
    textRects: [{ x: 20, y: 22, width: 180, height: 22 }],
  };
  it.each([0, 0.75, 2, 9.999, 10, 10.001, -2, -9.999, -10, -10.001])(
    "四边按原始逻辑 CSS 基准比较：位移 %s",
    (delta) => {
      const current = {
        ...saved,
        blocks: saved.blocks.map((rect) => ({
          ...rect,
          x: rect.x + delta,
          y: rect.y + delta,
        })),
        textRects: saved.textRects.map((rect) => ({
          ...rect,
          x: rect.x + delta,
          y: rect.y + delta,
        })),
      };
      expect(compatibleSurfaceEvidence(saved, current)).toBe(
        Math.abs(delta) <= 10,
      );
      expect(saved.blocks[0]?.x).toBe(20);
    },
  );
  it("分别偏移与变宽各 6px 时右边累计 12px，不能放行", () => {
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        blocks: saved.blocks.map((rect) => ({
          ...rect,
          x: rect.x + 6,
          width: rect.width + 6,
        })),
      }),
    ).toBe(false);
  });
  it("字体字符串和同一行碎片数量差异不独立阻断", () => {
    expect(
      compatibleSurfaceEvidence(saved, {
        ...saved,
        fonts: [
          normalizeSurfaceFont([
            "serif",
            "16.000001px",
            "normal",
            "28px",
            "0px",
          ]),
        ],
        textRects: [
          { x: 20, y: 22, width: 80, height: 22 },
          { x: 100, y: 22.2, width: 100, height: 22 },
        ],
      }),
    ).toBe(true);
  });
  it("语义节点、顺序和区域缺项仍严格拒绝", () => {
    const first = saved.blocks[0];
    if (!first) throw new Error("缺测试块");
    for (const blocks of [
      [],
      [{ ...first, node: "stem/p/1" }],
      [...saved.blocks, first],
    ]) {
      expect(compatibleSurfaceEvidence(saved, { ...saved, blocks })).toBe(
        false,
      );
    }
    const other = { ...first, node: "stem/p/1", y: 60 };
    expect(
      compatibleSurfaceEvidence(
        { ...saved, blocks: [first, other] },
        { ...saved, blocks: [other, first] },
      ),
    ).toBe(false);
  });
  it("第二设备的允许偏移不成为第三设备的新基准", () => {
    const shifted = (delta: number) => ({
      ...saved,
      blocks: saved.blocks.map((rect) => ({ ...rect, x: rect.x + delta })),
    });
    expect(compatibleSurfaceEvidence(saved, shifted(6))).toBe(true);
    expect(compatibleSurfaceEvidence(shifted(6), shifted(12))).toBe(true);
    expect(compatibleSurfaceEvidence(saved, shifted(12))).toBe(false);
  });
});
