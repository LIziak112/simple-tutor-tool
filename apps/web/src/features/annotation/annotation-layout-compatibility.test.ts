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
  it("允许半像素公式基线差异，拒绝换行、块顺序和明显偏移", () => {
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
        textRects: [{ x: 0, y: 4, width: 180, height: 22 }],
      }),
    ).toBe(false);
  });
});
