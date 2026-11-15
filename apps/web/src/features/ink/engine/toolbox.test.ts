import { describe, expect, it } from "vitest";
import {
  createInkToolbox,
  DEFAULT_INK_TOOLBOX,
  parseInkToolbox,
  selectInkTool,
  toolConfigOf,
} from "./toolbox.ts";

describe("工具箱状态（工具栏与书写面之间的单一事实来源）", () => {
  it("缺省：黑色中档笔、黄色荧光笔、整笔橡皮、直线形状", () => {
    expect(DEFAULT_INK_TOOLBOX).toEqual({
      active: "pen",
      pen: { color: "black", size: "medium" },
      highlighter: { color: "yellow", size: "medium", straight: false },
      eraser: { mode: "stroke", size: "medium" },
      shape: { kind: "line" },
    });
  });

  it("createInkToolbox：只覆盖给出的字段，且不与缺省值共享对象", () => {
    const toolbox = createInkToolbox({ pen: { color: "red", size: "thin" } });
    expect(toolbox.pen).toEqual({ color: "red", size: "thin" });
    expect(toolbox.highlighter).toEqual(DEFAULT_INK_TOOLBOX.highlighter);
    expect(toolbox.highlighter).not.toBe(DEFAULT_INK_TOOLBOX.highlighter);
    expect(createInkToolbox({ pen: { color: "blue" } }).pen).toEqual({
      color: "blue",
      size: "medium",
    });
  });

  it("toolConfigOf：每种工具下发完整配置", () => {
    const toolbox = createInkToolbox({
      pen: { color: "green", size: "heavy" },
      highlighter: { color: "pink", size: "thick", straight: true },
      eraser: { mode: "partial", size: "small" },
      shape: { kind: "arrow" },
    });
    expect(toolConfigOf(toolbox)).toEqual({
      type: "pen",
      color: "green",
      size: "heavy",
    });
    expect(toolConfigOf(selectInkTool(toolbox, "highlighter"))).toEqual({
      type: "highlighter",
      color: "pink",
      size: "thick",
      straight: true,
    });
    expect(toolConfigOf(selectInkTool(toolbox, "eraser"))).toEqual({
      type: "eraser",
      mode: "partial",
      size: "small",
    });
    expect(toolConfigOf(selectInkTool(toolbox, "shape"))).toEqual({
      type: "shape",
      shape: "arrow",
      color: "green",
      size: "heavy",
    });
    expect(toolConfigOf(selectInkTool(toolbox, "scroll"))).toEqual({
      type: "scroll",
    });
  });

  it("selectInkTool：只换当前工具，其余设置原样保留；同一工具返回原对象", () => {
    const toolbox = createInkToolbox({ pen: { color: "red", size: "thin" } });
    const next = selectInkTool(toolbox, "eraser");
    expect(next.active).toBe("eraser");
    expect(next.pen).toBe(toolbox.pen);
    expect(selectInkTool(toolbox, "pen")).toBe(toolbox);
  });

  it("parseInkToolbox：合法字段读回，非法字段逐项回退", () => {
    const fallback = createInkToolbox({ pen: { color: "red", size: "thin" } });
    expect(
      parseInkToolbox(
        {
          active: "highlighter",
          pen: { color: "purple", size: "nope" },
          highlighter: { color: "green", size: "thin", straight: "yes" },
          eraser: { mode: "partial", size: "large" },
          shape: { kind: "ellipse" },
        },
        fallback,
      ),
    ).toEqual({
      active: "highlighter",
      pen: { color: "purple", size: "thin" },
      highlighter: { color: "green", size: "thin", straight: false },
      eraser: { mode: "partial", size: "large" },
      shape: { kind: "ellipse" },
    });
  });

  it("parseInkToolbox：非对象、原型链上的键与不在允许列表里的当前工具都回退", () => {
    const fallback = createInkToolbox();
    expect(parseInkToolbox(null, fallback)).toEqual(fallback);
    expect(parseInkToolbox("pen", fallback)).toEqual(fallback);
    expect(
      parseInkToolbox(
        { active: "toString", pen: { color: "constructor" } },
        fallback,
      ),
    ).toEqual(fallback);
    expect(
      parseInkToolbox({ active: "shape" }, fallback, ["pen", "eraser"]).active,
    ).toBe("pen");
    expect(
      parseInkToolbox({ active: "eraser" }, fallback, ["pen", "eraser"]).active,
    ).toBe("eraser");
  });
});
