import { describe, expect, it } from "vitest";
import {
  hasIncompleteAiReplyMath,
  normalizeAiReplyMath,
  replyTextPage,
} from "./ai-reply-format";

describe("AI数学定界符兼容与有界原文", () => {
  it("识别独占行的裸公式，保留引用和代码围栏", () => {
    const source = [
      "推导：",
      String.raw`\frac{1}{x} + \lim_{x \to 0} f(x)`,
      String.raw`> \lim [A(x) + B(x)] = A + B`,
      String.raw`  \lim_{x \to 0} \frac{x}{x} = 1`,
      "```tex",
      String.raw`\frac{1}{2}`,
      "```",
    ].join("\n");
    const result = normalizeAiReplyMath(source);
    expect(result).toContain(
      String.raw`$$\n\frac{1}{x} + \lim_{x \to 0} f(x)\n$$`.replaceAll(
        "\\n",
        "\n",
      ),
    );
    expect(result).toContain(
      String.raw`> $$\n> \lim [A(x) + B(x)] = A + B\n> $$`.replaceAll(
        "\\n",
        "\n",
      ),
    );
    expect(result).toContain("```tex\n\\frac{1}{2}\n```");
    expect(result).toContain(
      String.raw`$$\n\lim_{x \to 0} \frac{x}{x} = 1\n$$`.replaceAll(
        "\\n",
        "\n",
      ),
    );
  });
  it("兼容模型常用的圆括号和方括号定界符", () => {
    expect(
      normalizeAiReplyMath(String.raw`先看 \(x+2\)，再看 \[x+2=5\]。`),
    ).toBe("先看 $x+2$，再看 \n$$\nx+2=5\n$$\n。");
  });
  it("不改变已有的多行公式块", () => {
    const source = ["$$", String.fromCharCode(92) + "frac{1}{2}", "$$"].join(
      String.fromCharCode(10),
    );
    expect(normalizeAiReplyMath(source)).toBe(source);
  });
  it("保留代码、链接和普通方括号，避免猜测数学", () => {
    const source =
      "`\\(code\\)`\n\n```tex\n\\[code\\]\n```\n\n[资料](https://example.com) [x+2=5]";
    expect(normalizeAiReplyMath(source)).toBe(source);
  });
  it("提示不完整的公式定界符，不将代码围栏中的字符当作错误", () => {
    expect(hasIncompleteAiReplyMath(String.raw`当 \to 0$ 时`)).toBe(true);
    expect(hasIncompleteAiReplyMath("```tex\n\\frac{1}{2}$\n```")).toBe(false);
    expect(hasIncompleteAiReplyMath(String.raw`$\frac{1}{2}$`)).toBe(false);
  });
  it("原文按固定字符预算分页，包含末尾且不执行任何标记", () => {
    const source = `<script>${"甲".repeat(20_000)}结尾`;
    expect(replyTextPage(source, 0).text.length).toBeLessThanOrEqual(4000);
    expect(replyTextPage(source, 5).text).toContain("结尾");
    expect(replyTextPage(source, 999).page).toBe(5);
  });
});
