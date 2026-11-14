import { DEFAULT_INK_PROFILE_CONFIG } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { forEachPaintRun, inSamePaintRun } from "./paint-runs.ts";
import { INK_HIGHLIGHTER, type InkStroke } from "./types.ts";

function stroke(over: Partial<InkStroke> = {}): InkStroke {
  return {
    tool: "highlighter",
    color: INK_HIGHLIGHTER.color,
    weight: INK_HIGHLIGHTER.weight,
    points: [
      { x: 0, y: 0, p: 0.5, t: 0 },
      { x: 50, y: 0, p: 0.5, t: 20 },
    ],
    ...over,
  };
}

const piece = (id: string, over: Partial<InkStroke> = {}) =>
  stroke({ id, cutFrom: "stroke-0001", ...over });

/** 各组里笔画的 id */
function runs(strokes: readonly InkStroke[]): Array<Array<string | undefined>> {
  const out: Array<Array<string | undefined>> = [];
  forEachPaintRun(strokes, (run) => out.push(run.map((item) => item.id)));
  return out;
}

describe("合在一起画的笔画", () => {
  it("同一笔切出来的荧光笔段算一组", () => {
    expect(inSamePaintRun(piece("piece-0001"), piece("piece-0002"))).toBe(true);
  });

  it("没被切过的笔画各画各的，哪怕颜色粗细一样（两笔之间重叠照旧叠深）", () => {
    expect(inSamePaintRun(stroke({ id: "a" }), stroke({ id: "b" }))).toBe(
      false,
    );
  });

  it("出自不同的笔不成组", () => {
    expect(
      inSamePaintRun(
        piece("piece-0001"),
        piece("piece-0002", { cutFrom: "stroke-0002" }),
      ),
    ).toBe(false);
  });

  it("不透明的笔不用成组：切出来的各段照旧逐笔画", () => {
    const pen = { tool: "pen", color: "#1f2328", weight: 4 } as const;
    expect(
      inSamePaintRun(piece("piece-0001", pen), piece("piece-0002", pen)),
    ).toBe(false);
  });

  it("颜色、线宽、画法有一样对不上就不成组（数据被改过也不会画错颜色）", () => {
    const base = piece("piece-0001");
    expect(
      inSamePaintRun(base, piece("piece-0002", { color: "rgba(0,0,0,0.4)" })),
    ).toBe(false);
    expect(inSamePaintRun(base, piece("piece-0002", { weight: 30 }))).toBe(
      false,
    );
    const freehand = {
      ...DEFAULT_INK_PROFILE_CONFIG,
      renderer: "freehand",
    } as const;
    expect(
      inSamePaintRun(base, piece("piece-0002", { rendering: freehand })),
    ).toBe(false);
    // 画法参数逐项相同即可，不要求是同一个对象（存取之后各是各的对象）
    expect(
      inSamePaintRun(
        piece("piece-0001", { rendering: { ...freehand } }),
        piece("piece-0002", { rendering: { ...freehand } }),
      ),
    ).toBe(true);
    expect(
      inSamePaintRun(
        piece("piece-0001", { rendering: freehand }),
        piece("piece-0002", { rendering: { ...freehand, sizeScale: 2 } }),
      ),
    ).toBe(false);
  });

  it("按绘制顺序分组：只有相邻的才并进一组，中间隔着别的笔画就断开", () => {
    const other = stroke({ id: "other" });
    expect(
      runs([
        stroke({ id: "before" }),
        piece("piece-0001"),
        piece("piece-0002"),
        piece("piece-0003"),
        other,
        piece("piece-0004"),
      ]),
    ).toEqual([
      ["before"],
      ["piece-0001", "piece-0002", "piece-0003"],
      ["other"],
      ["piece-0004"],
    ]);
  });

  it("没有笔画：不回调", () => {
    expect(runs([])).toEqual([]);
  });
});
