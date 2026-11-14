import { describe, expect, it } from "vitest";
import {
  INK_ERASE_RADIUS,
  INK_ERASER_SIZES,
  INK_HIGHLIGHTER,
  INK_HIGHLIGHTER_COLORS,
  INK_HIGHLIGHTER_SIZES,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
  type InkStroke,
  resolveGesture,
  resolveToolSpec,
  toolConfigFromStroke,
} from "./types.ts";

/** setTool 配置解析测试（验收项：setTool 切换） */
describe("resolveToolSpec（setTool 参数解析）", () => {
  it("pen：按颜色与粗细档位解析为绘制参数", () => {
    const r = resolveToolSpec(
      { type: "pen", color: "blue", size: "thick" },
      {
        color: "black",
        size: "medium",
      },
    );
    expect(r.brush).toEqual({
      color: INK_PEN_COLORS.blue,
      weight: INK_PEN_SIZES.thick,
    });
    expect(r.base).toEqual({ color: "blue", size: "thick" });
  });

  it("pen 缺省属性沿用上一次设置", () => {
    const r = resolveToolSpec({ type: "pen" }, { color: "red", size: "thin" });
    expect(r.brush).toEqual({
      color: INK_PEN_COLORS.red,
      weight: INK_PEN_SIZES.thin,
    });
  });

  it("highlighter 使用荧光笔参数；eraser/scroll 无笔刷", () => {
    const h = resolveToolSpec(
      { type: "highlighter" },
      { color: "black", size: "medium" },
    );
    expect(h.brush).toEqual(INK_HIGHLIGHTER);
    expect(resolveToolSpec({ type: "eraser" }, h.base).brush).toBeNull();
    expect(resolveToolSpec({ type: "scroll" }, h.base).brush).toBeNull();
  });

  it("旧档位的取值不变：已落库笔迹按原颜色与线宽反查得到原档位", () => {
    expect(INK_PEN_SIZES).toMatchObject({ thin: 2.5, medium: 4, thick: 6 });
    expect(INK_PEN_COLORS).toMatchObject({
      black: "#1f2328",
      blue: "#1d4ed8",
      red: "#dc2626",
    });
    expect(INK_HIGHLIGHTER).toEqual({
      color: "rgba(250, 204, 21, 0.45)",
      weight: 16,
    });
    expect(INK_ERASER_SIZES.medium).toBe(INK_ERASE_RADIUS);
    expect(INK_ERASE_RADIUS).toBe(14);
  });

  it("highlighter：颜色与粗细可选，缺省为黄色中档，且不改动笔的记忆", () => {
    const base = { color: "red", size: "thin" } as const;
    const r = resolveToolSpec(
      { type: "highlighter", color: "green", size: "thick" },
      base,
    );
    expect(r.brush).toEqual({
      color: INK_HIGHLIGHTER_COLORS.green,
      weight: INK_HIGHLIGHTER_SIZES.thick,
    });
    expect(r.base).toEqual(base);
    expect(
      resolveToolSpec({ type: "highlighter", color: "pink" }, base).brush,
    ).toEqual({
      color: INK_HIGHLIGHTER_COLORS.pink,
      weight: INK_HIGHLIGHTER_SIZES.medium,
    });
  });

  it("shape：与笔共用颜色、粗细及其记忆", () => {
    const r = resolveToolSpec(
      { type: "shape", shape: "rect", color: "green", size: "heavy" },
      { color: "black", size: "medium" },
    );
    expect(r.brush).toEqual({
      color: INK_PEN_COLORS.green,
      weight: INK_PEN_SIZES.heavy,
    });
    expect(r.base).toEqual({ color: "green", size: "heavy" });
    expect(resolveToolSpec({ type: "shape" }, r.base).brush).toEqual(r.brush);
  });
});

describe("resolveGesture（落笔时的手势快照）", () => {
  const base = { color: "black", size: "medium" } as const;

  it("笔：自由书写", () => {
    expect(
      resolveGesture({ type: "pen", color: "red", size: "thin" }, base),
    ).toEqual({
      gesture: {
        kind: "draw",
        tool: "pen",
        shape: "free",
        brush: { color: INK_PEN_COLORS.red, weight: INK_PEN_SIZES.thin },
      },
      base: { color: "red", size: "thin" },
    });
  });

  it("荧光笔：缺省自由书写，straight 时画直线", () => {
    expect(resolveGesture({ type: "highlighter" }, base).gesture).toEqual({
      kind: "draw",
      tool: "highlighter",
      shape: "free",
      brush: INK_HIGHLIGHTER,
    });
    expect(
      resolveGesture({ type: "highlighter", straight: true }, base).gesture,
    ).toMatchObject({ kind: "draw", tool: "highlighter", shape: "line" });
  });

  it("形状：落成普通笔画，缺省为直线", () => {
    expect(resolveGesture({ type: "shape" }, base).gesture).toEqual({
      kind: "draw",
      tool: "pen",
      shape: "line",
      brush: { color: INK_PEN_COLORS.black, weight: INK_PEN_SIZES.medium },
    });
    expect(
      resolveGesture({ type: "shape", shape: "ellipse" }, base).gesture,
    ).toMatchObject({ kind: "draw", tool: "pen", shape: "ellipse" });
  });

  it("橡皮：缺省整笔擦除、中号半径；可选局部擦除与大小", () => {
    expect(resolveGesture({ type: "eraser" }, base).gesture).toEqual({
      kind: "erase",
      mode: "stroke",
      radius: INK_ERASE_RADIUS,
    });
    expect(
      resolveGesture({ type: "eraser", mode: "partial", size: "large" }, base)
        .gesture,
    ).toEqual({
      kind: "erase",
      mode: "partial",
      radius: INK_ERASER_SIZES.large,
    });
  });

  it("滚动：不产生手势", () => {
    expect(resolveGesture({ type: "scroll" }, base).gesture).toEqual({
      kind: "none",
    });
  });
});

describe("toolConfigFromStroke（笔画反查工具配置）", () => {
  const stroke = (patch: Partial<InkStroke>): InkStroke => ({
    tool: "pen",
    color: INK_PEN_COLORS.black,
    weight: INK_PEN_SIZES.medium,
    points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
    ...patch,
  });

  it("笔：新增的颜色与粗细档位可反查", () => {
    expect(
      toolConfigFromStroke(
        stroke({
          color: INK_PEN_COLORS.purple,
          weight: INK_PEN_SIZES.hairline,
        }),
      ),
    ).toEqual({ type: "pen", color: "purple", size: "hairline" });
  });

  it("笔：未知取值回退黑色中档", () => {
    expect(
      toolConfigFromStroke(stroke({ color: "#123456", weight: 99 })),
    ).toEqual({ type: "pen", color: "black", size: "medium" });
  });

  it("荧光笔：颜色与粗细可反查，未知取值回退缺省荧光笔", () => {
    expect(
      toolConfigFromStroke(
        stroke({
          tool: "highlighter",
          color: INK_HIGHLIGHTER_COLORS.blue,
          weight: INK_HIGHLIGHTER_SIZES.thin,
        }),
      ),
    ).toEqual({ type: "highlighter", color: "blue", size: "thin" });
    expect(
      toolConfigFromStroke(
        stroke({ tool: "highlighter", color: "#fff", weight: 3 }),
      ),
    ).toEqual({ type: "highlighter", color: "yellow", size: "medium" });
  });
});
