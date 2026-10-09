import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutlineInlineMath, splitInlineMath } from "./outline-inline-math";
import { RichMarkdown } from "./RichMarkdown";

/**
 * 目录行内公式组件测试（T6R.23 P2-4，路径 A）：目录条目文本按 $...$ 切分，
 * 公式段用 katex.renderToString 渲染、非公式段保持纯文本；并锁定与正文
 * 渲染管线（remark-math + rehype-katex）的公式识别口径一致——同一标题
 * 在目录与正文两处的 KaTeX 渲染数必须相同。
 */

/** 便捷渲染 */
function renderOutlineText(text: string) {
  return render(<OutlineInlineMath text={text} />);
}

describe("splitInlineMath：$...$ 切分", () => {
  it("混合文本切出公式段与文本段（公式段剥除定界符）", () => {
    expect(splitInlineMath("1. $\\varepsilon-N$ 严格定义")).toEqual([
      { value: "1. ", math: false },
      { value: "\\varepsilon-N", math: true },
      { value: " 严格定义", math: false },
    ]);
  });

  it("多个公式依次切分", () => {
    expect(splitInlineMath("若 $a>b$ 且 $b>c$ 则 $a>c$")).toEqual([
      { value: "若 ", math: false },
      { value: "a>b", math: true },
      { value: " 且 ", math: false },
      { value: "b>c", math: true },
      { value: " 则 ", math: false },
      { value: "a>c", math: true },
    ]);
  });

  it("未配对 $ 按字面量；货币式 $…$ 空白不阻断配对（与 remark-math 同口径）", () => {
    expect(splitInlineMath("a $ b")).toEqual([{ value: "a $ b", math: false }]);
    // remark-math 的 mathText 允许公式内空白：正文把「5 和 」渲染为公式，
    // 目录必须同口径（两边对同一标题的展示一致）
    expect(splitInlineMath("价格 $5 和 $10")).toEqual([
      { value: "价格 ", math: false },
      { value: "5 和 ", math: true },
      { value: "10", math: false },
    ]);
  });

  it("空白内层公式（$ $）同样配对", () => {
    expect(splitInlineMath("a $ $ b")).toEqual([
      { value: "a ", math: false },
      { value: " ", math: true },
      { value: " b", math: false },
    ]);
  });

  it("$$ 连排与空串：不识别公式", () => {
    expect(splitInlineMath("$$x$$")).toEqual([{ value: "$$x$$", math: false }]);
    expect(splitInlineMath("")).toEqual([]);
  });
});

describe("OutlineInlineMath：目录行内公式渲染", () => {
  it("混合文本：公式段渲染 KaTeX 标记，非公式段保持文本节点", () => {
    const { container } = renderOutlineText("1. $\\varepsilon-N$ 严格定义");
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    // 非公式段以文本存在（目录可检索、可复制）
    expect(container.textContent).toContain("1.");
    expect(container.textContent).toContain("严格定义");
    // 公式产出真实排版字符（MathML 语义层含 ε），定界符不暴露
    expect(container.textContent).toContain("ε");
    expect(container.textContent).not.toContain("$");
  });

  it("纯公式标题整段渲染为公式", () => {
    const { container } = renderOutlineText("$x^2$");
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).not.toContain("$x");
  });

  it("多个公式全部渲染", () => {
    const { container } = renderOutlineText("若 $a>b$ 且 $b>c$ 则 $a>c$");
    expect(container.querySelectorAll(".katex")).toHaveLength(3);
  });

  it("未配对 $：字面量展示、不渲染公式", () => {
    const { container } = renderOutlineText("a $ b");
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(container.textContent).toBe("a $ b");
  });

  it("空串不渲染任何内容", () => {
    const { container } = renderOutlineText("");
    expect(container.textContent).toBe("");
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
  });
});

describe("目录组件与正文管线的公式识别口径一致", () => {
  const cases = [
    "1. $\\varepsilon-N$ 严格定义",
    "$x^2$",
    "a $ b",
    "价格 $5 与 $10 的对比",
    "a $ $ b",
  ];

  it.each(cases)("%s：目录与正文 h3 的 KaTeX 渲染数一致", (text) => {
    const { container: outline } = renderOutlineText(text);
    const { container: body } = render(<RichMarkdown source={`### ${text}`} />);
    const outlineCount = outline.querySelectorAll(".katex").length;
    const bodyCount = body.querySelectorAll(".rich-markdown h3 .katex").length;
    expect(outlineCount, "目录 KaTeX 渲染数").toBe(bodyCount);
  });
});
