import { describe, expect, it } from "vitest";
import { resolveToolSpec, INK_HIGHLIGHTER, INK_PEN_COLORS, INK_PEN_SIZES } from "./types.ts";

/** setTool 配置解析测试（验收项：setTool 切换） */
describe("resolveToolSpec（setTool 参数解析）", () => {
  it("pen：按颜色与粗细档位解析为绘制参数", () => {
    const r = resolveToolSpec({ type: "pen", color: "blue", size: "thick" }, {
      color: "black",
      size: "medium",
    });
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
    const h = resolveToolSpec({ type: "highlighter" }, { color: "black", size: "medium" });
    expect(h.brush).toEqual(INK_HIGHLIGHTER);
    expect(resolveToolSpec({ type: "eraser" }, h.base).brush).toBeNull();
    expect(resolveToolSpec({ type: "scroll" }, h.base).brush).toBeNull();
  });
});
