import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DirectiveSessionProvider } from "./directives/session-context";
import { InlineMarkdown } from "./InlineMarkdown";

/**
 * InlineMarkdown 组件测试（2026-10，错题本紧凑行「题目缩略未渲染」修复 #6972 第 1 条）：
 * 单行收敛形态——公式 KaTeX、图片/表格/函数图像占位、块级元素降为 span、
 * 填空恒为展示空框、链接与复选框不进按钮、与 RichMarkdown 同一 sanitize。
 */

/** 块级 / 交互元素选择器（按钮内只允许短语内容） */
const BLOCK_OR_INTERACTIVE =
  "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table, img, a, input, hr, br, figure, details";

/** 公式子树外的正文（KaTeX 的 MathML <annotation> 本就携带 TeX 源码，不算残留） */
function textOutsideMath(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const math of clone.querySelectorAll(".katex")) math.remove();
  return clone.textContent ?? "";
}

function renderInline(source: string) {
  const result = render(<InlineMarkdown source={source} />);
  const root = result.container.querySelector(".rich-markdown-inline");
  if (!(root instanceof HTMLElement)) throw new Error("缺少根元素");
  return { ...result, root };
}

describe("InlineMarkdown：公式", () => {
  it("行内公式渲染为 KaTeX，公式外正文不残留 \\frac / $ 原文；根元素是 span 且不含块级元素", () => {
    const { root } = renderInline("计算 $\\frac{1}{2}x+3=5$ 的**相反数**");
    expect(root.tagName).toBe("SPAN");
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
    expect(root.querySelector(".mfrac")).not.toBeNull();
    const prose = textOutsideMath(root);
    expect(prose).not.toContain("\\frac");
    expect(prose).not.toContain("$");
    expect(prose).toContain("计算");
    expect(root.querySelector("strong")).toHaveTextContent("相反数");
    expect(root.querySelector(BLOCK_OR_INTERACTIVE)).toBeNull();
  });

  it("围栏块级公式照常渲染为 katex-display（随行内排由 .rich-markdown-inline 样式负责），不产生块级包裹", () => {
    const { root } = renderInline(
      ["已知", "", "$$", "E=mc^2", "$$", "", "求 $m$。"].join("\n"),
    );
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
    expect(root.querySelector(".katex-display")).not.toBeNull();
    expect(root.classList.contains("rich-markdown-inline")).toBe(true);
    expect(root.querySelector(BLOCK_OR_INTERACTIVE)).toBeNull();
    expect(textOutsideMath(root)).not.toContain("$$");
  });
});

describe("InlineMarkdown：媒体与表格占位", () => {
  it("Markdown 图片 ![alt](src) 降级为「[图]」，alt 进无障碍名，不渲染 <img>", () => {
    const { root } = renderInline(
      "如图，![三角形 ABC](blobs/tri.png) 求面积。",
    );
    expect(root.querySelector("img")).toBeNull();
    const placeholder = screen.getByRole("img", { name: "图：三角形 ABC" });
    expect(placeholder).toHaveTextContent("[图]");
    expect(root.textContent).not.toContain("![");
    expect(root.textContent).not.toContain("blobs/tri.png");
    expect(root).toHaveTextContent(/如图，.*求面积。/);
  });

  it("::image 块指令降级为「[图]」、::graph 降级为「[函数图像]」，不加载图片 / 不动态引入绘图库", () => {
    const { root } = renderInline(
      [
        "观察图像：",
        "",
        '::image{src="blobs/fig-1.png" alt="数轴示意图" width="60%"}',
        "",
        '::graph{fn="x^2" range="-3,3"}',
        "",
        "写出对称轴。",
      ].join("\n"),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("figure, [data-graph-canvas]")).toBeNull();
    expect(
      screen.getByRole("img", { name: "图：数轴示意图" }),
    ).toHaveTextContent("[图]");
    expect(screen.getByRole("img", { name: "函数图像" })).toHaveTextContent(
      "[函数图像]",
    );
    expect(root).toHaveTextContent(/观察图像：.*写出对称轴。/);
    expect(root.querySelector(BLOCK_OR_INTERACTIVE)).toBeNull();
  });

  it("GFM 表格降级为「[表格]」，单元格内容与竖线都不进预览，表外正文保留", () => {
    const { root } = renderInline(
      ["| 边 | 长 |", "| - | - |", "| a | 3 |", "", "求周长。"].join("\n"),
    );
    expect(root.querySelector("table, thead, tbody, tr, th, td")).toBeNull();
    expect(root).toHaveTextContent("[表格]");
    expect(root.textContent).not.toContain("|");
    expect(root.textContent).not.toContain("边");
    expect(root).toHaveTextContent(/求周长。/);
  });
});

describe("InlineMarkdown：块级与交互元素收敛", () => {
  it("标题 / 列表 / 引用 / 代码块降为 span，正文保留；分隔线与换行不产生块级或 <br>", () => {
    const { root } = renderInline(
      [
        "# 第一题",
        "",
        "> 已知条件",
        "",
        "1. 第一问",
        "2. 第二问",
        "",
        "```",
        "print(1)",
        "```",
        "",
        "---",
        "",
        "第一行  ",
        "第二行",
      ].join("\n"),
    );
    expect(root.querySelector(BLOCK_OR_INTERACTIVE)).toBeNull();
    expect(root).toHaveTextContent(
      /第一题.*已知条件.*第一问.*第二问.*print\(1\).*第一行\s+第二行/,
    );
    // 行内代码样式沿用 .rich-markdown code（代码块只去掉 <pre> 外壳）
    expect(root.querySelector("code")).toHaveTextContent("print(1)");
  });

  it("链接降为纯文本（不渲染 <a>）、任务列表复选框不渲染（不渲染 <input>）", () => {
    const { root } = renderInline(
      [
        "参考 [教材](https://example.com/p1) 第 3 页：",
        "",
        "- [ ] 甲",
        "- [x] 乙",
      ].join("\n"),
    );
    expect(root.querySelector("a, input")).toBeNull();
    expect(root).toHaveTextContent(/参考 教材 第 3 页：.*甲.*乙/);
    expect(root.textContent).not.toContain("https://example.com");
  });
});

describe("InlineMarkdown：指令", () => {
  it("[[答案]] 渲染为展示空框且答案不显示；即使外层提供作答态也不渲染输入框（预览恒为展示形态）", () => {
    const { container } = render(
      <DirectiveSessionProvider
        fill={{ values: ["4"], onChange: () => {}, disabled: false }}
      >
        <InlineMarkdown source="解得 $x=$ [[4]]。" />
      </DirectiveSessionProvider>,
    );
    expect(container.querySelectorAll('[data-testid="blank"]')).toHaveLength(1);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("[[4]]");
    expect(textOutsideMath(container)).not.toContain("4");
  });

  it(":mark 行内高亮照常渲染；容器指令（:::tip）与未知指令只保留正文，不渲染块级外壳", () => {
    const { root } = renderInline(
      [
        ":::tip",
        "注意 :mark[符号]{color=red} 不能丢。",
        ":::",
        "",
        ":::unknown-thing",
        "降级正文",
        ":::",
      ].join("\n"),
    );
    expect(root.querySelector("mark")).toHaveTextContent("符号");
    expect(root).toHaveTextContent(/注意 符号 不能丢。.*降级正文/);
    expect(root.querySelector(BLOCK_OR_INTERACTIVE)).toBeNull();
    // 不显示「未知指令」之类的降级提示（预览只要正文）
    expect(root.textContent).not.toContain("unknown-thing");
  });

  it("与 RichMarkdown 同一 sanitize：原始 HTML 标签、事件属性与危险协议图片不进 DOM", () => {
    const { root } = renderInline(
      [
        '题干 <script>alert(1)</script><img src=x onerror="alert(1)"> 结束',
        "",
        '::image{src="javascript:alert(1)"}',
      ].join("\n"),
    );
    expect(root.querySelector("script, img, [onerror]")).toBeNull();
    // ::image 在预览里只渲染「[图]」占位，不加载也不透出任何 src（危险协议已被 sanitize 剥除）
    expect(root).toHaveTextContent("[图]");
    expect(root.textContent).not.toContain("javascript:");
    expect(root).toHaveTextContent(/题干.*结束/);
  });
});
