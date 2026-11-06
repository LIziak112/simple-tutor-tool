import { describe, expect, it } from "vitest";
import { checkAiReply, prepareAiReplyMarkdown } from "./check.ts";

describe("AI 回信格式检查与历史显示", () => {
  it("复现 #54：遗漏定界符不跨行吞掉中文", () => {
    const source =
      String.raw`结果是 -\frac{1}{2}$（负数）。` +
      "\n\n" +
      String.raw`当 $x$ 趋近零时。`;
    const result = checkAiReply(source);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "UNCLOSED_MATH", line: 1 }),
    );
    expect(prepareAiReplyMarkdown(source)).toContain(
      String.raw`当 $x$ 趋近零时。`,
    );
    expect(prepareAiReplyMarkdown(source)).toContain(
      String.raw`结果是 -\frac{1}{2}$（负数）。`,
    );
  });
  it.each([
    String.raw`$\frac{1}{2}$`,
    "$$\n\\begin{array}{c}1\\\\2\\end{array}\n$$",
    String.raw`先看 \(x+1\)，再看 \[x=2\]。`,
  ])("保留合法公式：%s", (source) => {
    expect(checkAiReply(source).valid).toBe(true);
  });
  it("跳过代码、链接、转义和金额", () => {
    const source =
      "```tex\n\\frac{1}{2}$\n```\n`$\\bad`\n[资料](https://example.com/$a)\n价格 $5，字面符号 \\$。";
    expect(checkAiReply(source).valid).toBe(true);
  });
  it("报告裸公式但不阻断，历史显示继续兼容", () => {
    const source = String.raw`-\frac{1}{2}`;
    expect(checkAiReply(source).issues).toContainEqual(
      expect.objectContaining({ code: "BARE_LATEX", severity: "warning" }),
    );
    expect(checkAiReply(source).valid).toBe(true);
    expect(prepareAiReplyMarkdown(source)).toContain("$$");
  });
  it("KaTeX 错误、未闭合块及超预算是确定错误", () => {
    for (const source of [
      String.raw`$\notARealCommand{1}$`,
      "$$\nx=1",
      "$" + "x".repeat(1001) + "$",
      "$x$ ".repeat(81),
      "字".repeat(40_001),
    ]) {
      expect(checkAiReply(source).valid).toBe(false);
    }
  });
  it("按原文定位中文、emoji 和 CRLF，不把 warning 当作 error", () => {
    const result = checkAiReply("中文😀\r\n" + String.raw`$\badcommand$`);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ line: 2, column: 1, severity: "error" }),
    );
  });
  it("正常块不被历史兜底修改", () => {
    const source = "$$\n\\frac{1}{2}\n$$\n\n当 $x$ 趋近零时。";
    expect(prepareAiReplyMarkdown(source)).toBe(source);
  });
  it("诊断有界时不能因前面 warning 太多而漏掉 error", () => {
    expect(
      checkAiReply(
        (String.raw`\frac{1}{2}` + "\n").repeat(60) + String.raw`$\badcommand$`,
      ).valid,
    ).toBe(false);
  });
  it("明确的变量公式缺闭合符要拒绝；金额只提示", () => {
    expect(checkAiReply("设 $x+1").valid).toBe(false);
    expect(checkAiReply("价格 $5").valid).toBe(true);
    expect(checkAiReply("  ").valid).toBe(false);
  });
  it("历史回信中的缩进代码不参与定界符转换", () => {
    const source = "    \\[x+1\\]\n";
    expect(prepareAiReplyMarkdown(source)).toBe(source);
  });
  it("同一行两个尾定界符不能把夹在中间的中文当成可信公式", () => {
    const source = String.raw`结果为 -\frac{1}{2}$（负数），另一结果为 -\frac{1}{3}$（负数）。`;
    expect(checkAiReply(source).issues).toContainEqual(
      expect.objectContaining({ code: "SUSPECT_MATH", severity: "warning" }),
    );
    expect(prepareAiReplyMarkdown(source)).toContain("``` ");
  });
  it("显式 text 只能豁免它包裹的内容，不能遮住其他误配的中文", () => {
    const source = String.raw`结果为 -\frac{1}{2}$（负数），\text{a}另一结果为 -\frac{1}{3}$（负数）。`;
    expect(checkAiReply(source).issues).toContainEqual(
      expect.objectContaining({ code: "SUSPECT_MATH" }),
    );
    expect(
      checkAiReply(String.raw`裸 \frac{1}{2} 与 $\text{中文}$`).issues.some(
        (issue) => issue.code === "SUSPECT_MATH",
      ),
    ).toBe(false);
  });
  it("预算内连续反斜杠可以完成检查", () => {
    expect(checkAiReply("\\".repeat(40_000)).valid).toBe(true);
  });
  it("按页面实际数学语法检查：同一行 $$ 的 tag 不能冒充块公式", () => {
    expect(checkAiReply(String.raw`$$x\tag{1}$$`).valid).toBe(false);
  });
  it("历史兼容生成的公式仍计入显示预算", () => {
    expect(
      checkAiReply((String.raw`\frac{1}{2}` + "\n").repeat(81)).valid,
    ).toBe(false);
  });
});
