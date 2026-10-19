import { describe, expect, it } from "vitest";
import { normalizeAiReplyMath, replyTextPage } from "./ai-reply-format";

describe("AI数学定界符兼容与有界原文", () => {
  it("兼容模型常用的圆括号和方括号定界符", () => {
    expect(
      normalizeAiReplyMath(String.raw`先看 \(x+2\)，再看 \[x+2=5\]。`),
    ).toBe("先看 $x+2$，再看 \n$$\nx+2=5\n$$\n。");
  });
  it("保留代码、链接和普通方括号，避免猜测数学", () => {
    const source =
      "`\\(code\\)`\n\n```tex\n\\[code\\]\n```\n\n[资料](https://example.com) [x+2=5]";
    expect(normalizeAiReplyMath(source)).toBe(source);
  });
  it("原文按固定字符预算分页，包含末尾且不执行任何标记", () => {
    const source = `<script>${"甲".repeat(20_000)}结尾`;
    expect(replyTextPage(source, 0).text.length).toBeLessThanOrEqual(4000);
    expect(replyTextPage(source, 5).text).toContain("结尾");
    expect(replyTextPage(source, 999).page).toBe(5);
  });
});
