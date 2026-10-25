import { describe, expect, it } from "vitest";
import { compactInlineSource } from "./compact-inline";

/**
 * compactInlineSource 单测：单行收敛形态的源文降级口径——图片/表格占位、
 * 块级公式转行内、指令围栏剥离，行内公式与普通文本原样保留。
 */
describe("compactInlineSource：单行收敛形态的源文降级", () => {
  it("图片降级为 [图] 占位", () => {
    expect(compactInlineSource("看图作答 ![几何图](media/geo.png) 完成")).toBe(
      "看图作答 [图] 完成",
    );
  });

  it("表格块降级为单个 [表格] 占位（含分隔行与多行表体）", () => {
    const src =
      "如下表：\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n后文";
    expect(compactInlineSource(src)).toBe("如下表：\n\n[表格]\n\n后文");
  });

  it("块级公式收敛为行内（只去 $$ 定界与换行，内容不动）", () => {
    expect(compactInlineSource("公式：\n\n$$\\frac{1}{2}$$\n\n结束")).toBe(
      "公式：\n\n$\\frac{1}{2}$\n\n结束",
    );
  });

  it("指令围栏标记剥离，内容保留", () => {
    expect(compactInlineSource(":::hint\n提示内容\n:::")).toBe("提示内容\n");
  });

  it("行内公式与普通文本原样保留", () => {
    expect(compactInlineSource("计算 $\\frac{1}{2}$ 的**相反数**")).toBe(
      "计算 $\\frac{1}{2}$ 的**相反数**",
    );
  });
});
