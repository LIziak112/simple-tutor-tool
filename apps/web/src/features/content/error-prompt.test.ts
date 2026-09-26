import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { buildLintErrorPrompt } from "./error-prompt.ts";

/**
 * "复制错误给 AI"提示词格式化纯函数测试（T1.11 验收：复制出的提示词可直接使用）：
 * 含原文与文件名、错误行（行号/[CODE]/中文消息/fix 建议）、修正要求两条；
 * v1 附加行号说明；原文含三反引号代码块时围栏不被破坏。
 */

const ISSUES: LintIssue[] = [
  {
    level: "error",
    line: 6,
    column: 1,
    code: "FILL_NO_BLANK",
    message: "填空题题干没有任何 [[…]] 空",
    fix: "在题干中用 [[答案]] 标记空位",
  },
  {
    level: "warning",
    line: 9,
    column: 3,
    code: "UNKNOWN_DIRECTIVE",
    message: "未注册的指令「:::tipl」，你是不是想用「:::tip」？",
  },
];

const MD = [
  "---",
  "kind: practice",
  "unit: 练习四",
  "---",
  "",
  "::::question{type=fill difficulty=2}",
  "计算：1+1=2。",
  "::::",
].join("\n");

describe("buildLintErrorPrompt", () => {
  it("提示词含原文全文、文件名与四反引号围栏", () => {
    const prompt = buildLintErrorPrompt({
      filename: "练习四.md",
      markdown: MD,
      issues: ISSUES,
      version: 2,
    });
    expect(prompt).toContain("练习四.md");
    expect(prompt).toContain("````markdown");
    expect(prompt).toContain(MD);
    // 原文完整包裹在围栏里（围栏出现在原文之前之后）
    expect(prompt.indexOf("````markdown")).toBeLessThan(
      prompt.indexOf("kind: practice"),
    );
  });

  it("错误列表逐条含行号、[CODE]、中文消息与 fix 建议", () => {
    const prompt = buildLintErrorPrompt({
      filename: "练习四.md",
      markdown: MD,
      issues: ISSUES,
      version: 2,
    });
    expect(prompt).toContain("## 错误列表");
    expect(prompt).toContain(
      "- 第6行 第1列 [FILL_NO_BLANK] 填空题题干没有任何 [[…]] 空（修正建议：在题干中用 [[答案]] 标记空位）",
    );
    expect(prompt).toContain(
      "- 第9行 第3列 [UNKNOWN_DIRECTIVE] 未注册的指令「:::tipl」，你是不是想用「:::tip」？",
    );
    // warning 无 fix 时不出现"修正建议"字样污染该行
    const warningLine = prompt
      .split("\n")
      .find((line) => line.includes("UNKNOWN_DIRECTIVE"));
    expect(warningLine).not.toContain("修正建议");
  });

  it("结尾是两条修正要求（不改无关内容与 id、仅输出代码块）", () => {
    const prompt = buildLintErrorPrompt({
      filename: "练习四.md",
      markdown: MD,
      issues: ISSUES,
      version: 2,
    });
    expect(prompt).toContain("## 要求");
    expect(prompt).toContain(
      "1. 逐条修正上述错误，不要改动无关内容与题目 id；",
    );
    expect(prompt).toContain(
      "2. 输出修正后的完整 markdown（仅代码块，不要解释）。",
    );
    // 要求段在错误列表之后
    expect(prompt.indexOf("## 要求")).toBeGreaterThan(
      prompt.indexOf("## 错误列表"),
    );
  });

  it("v1 文档附加行号对应转换后 v2 文本的说明；v2 不附加", () => {
    const v1 = buildLintErrorPrompt({
      filename: "示例练习.md",
      markdown: MD,
      issues: ISSUES,
      version: 1,
    });
    expect(v1).toContain("旧版 v1 文档");
    expect(v1).toContain("行号对应自动转换后的 v2 文本");

    const v2 = buildLintErrorPrompt({
      filename: "练习四.md",
      markdown: MD,
      issues: ISSUES,
      version: 2,
    });
    expect(v2).not.toContain("旧版 v1 文档");
  });

  it("原文含三反引号代码块时提示词围栏结构不被破坏", () => {
    const mdWithFence = `${MD}\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n`;
    const prompt = buildLintErrorPrompt({
      filename: "混合.md",
      markdown: mdWithFence,
      issues: ISSUES,
      version: 2,
    });
    // 四反引号开闭围栏各恰好一次，内部三反引号原样保留
    expect(prompt.split("````markdown").length).toBe(2);
    expect(prompt).toContain("```js");
  });

  it("无 issue 时错误列表为（无），不崩溃（防御：按钮理论上只在有问题时出现）", () => {
    const prompt = buildLintErrorPrompt({
      filename: "空.md",
      markdown: "",
      issues: [],
      version: 2,
    });
    expect(prompt).toContain("（无）");
  });
});
