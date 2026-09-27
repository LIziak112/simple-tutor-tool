import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { buildFixPrompt, type FixPromptFile } from "./error-prompt.ts";

/**
 * "复制错误给 AI"提示词纯函数测试（T2A.3 按 D21 重写）：
 * - 输出含路径、行号、CODE、±3 行带行号片段；**不含与错误无关的正文**（不附全文）；
 * - 相邻错误片段合并；远离的片段分开；
 * - 片段总行数超 200 行截断并注明「其余 N 处错误略」；
 * - 无路径（粘贴内容）标注「粘贴内容（无文件路径）」；
 * - 多文件逐文件列出；v1 附加行号说明；四反引号围栏不被原文三反引号破坏。
 */

const ERROR_AT_6: LintIssue = {
  level: "error",
  line: 6,
  column: 1,
  code: "FILL_NO_BLANK",
  message: "填空题题干没有任何 [[…]] 空",
  fix: "在题干中用 [[答案]] 标记空位",
};

const WARNING_AT_12: LintIssue = {
  level: "warning",
  line: 12,
  column: 3,
  code: "UNKNOWN_DIRECTIVE",
  message: "未注册的指令「:::tipl」，你是不是想用「:::tip」」？",
};

/** 15 行样例文档：第 6 行与第 12 行有错误 */
const MD = [
  "---", // 1
  "kind: practice", // 2
  "unit: 练习四", // 3
  "---", // 4
  "", // 5
  "::::question{type=fill difficulty=2}", // 6（错误）
  "计算：1+1=2。", // 7
  "::::", // 8
  "", // 9
  "远离错误的正文行甲。", // 10
  "远离错误的正文行乙。", // 11
  ":::tipl 未注册指令", // 12（警告）
  "远离错误的正文行丙。", // 13
  "远离错误的正文行丁。", // 14
  "结尾行。", // 15
].join("\n");

function file(overrides: Partial<FixPromptFile> = {}): FixPromptFile {
  return {
    path: "chapter1/练习.md",
    markdown: MD,
    issues: [ERROR_AT_6, WARNING_AT_12],
    version: 2,
    ...overrides,
  };
}

describe("buildFixPrompt（D21 新格式）", () => {
  it("含相对路径、错误列表（行:列/[CODE]/消息/修复建议）与 ±3 行带行号片段", () => {
    const prompt = buildFixPrompt([file()]);
    expect(prompt).toContain("## chapter1/练习.md");
    expect(prompt).toContain("### 错误列表");
    expect(prompt).toContain(
      "- 第6行 第1列 [FILL_NO_BLANK] 填空题题干没有任何 [[…]] 空（修复建议：在题干中用 [[答案]] 标记空位）",
    );
    expect(prompt).toContain("- 第12行 第3列 [UNKNOWN_DIRECTIVE]");
    // 片段：第 6 行错误 → 第 3~9 行（±3）；带行号前缀
    expect(prompt).toContain("````markdown");
    expect(prompt).toContain("   3 | unit: 练习四");
    expect(prompt).toContain("   6 | ::::question{type=fill difficulty=2}");
    expect(prompt).toContain("   9 | ");
    // 修正要求说明（D21 原文）
    expect(prompt).toContain(
      "请按路径打开这些文件，只修正列出的问题，不要改动其他内容；若你无法访问文件，请让我提供完整文件。",
    );
  });

  it("不附全文：片段之外（远离错误行）的正文不出现（验收）", () => {
    // 第 6 行 ±3 → 3~9 行；第 12 行 ±3 → 9~15 行；两片段相邻（9 行重叠）→ 合并为 3~15
    // 因此 10/11/13/14 行其实在合并后的片段内——换远离的行验证"无关正文不出现"
    const distant = file({
      markdown: MD,
      issues: [ERROR_AT_6], // 只留第 6 行错误 → 片段 3~9 行
    });
    const promptDistant = buildFixPrompt([distant]);
    expect(promptDistant).not.toContain("远离错误的正文行甲。");
    expect(promptDistant).not.toContain("结尾行。");
    expect(promptDistant).toContain("   6 | ");
  });

  it("相邻片段合并：第 6 行与第 12 行错误（区间重叠）→ 单个连续片段 3~15 行", () => {
    const prompt = buildFixPrompt([file()]);
    // 合并片段：3 起到 15 止，中间无围栏断开
    expect(prompt).toContain("   3 | ");
    expect(prompt).toContain("  15 | 结尾行。");
    // 只有一对围栏（单文件单片段）
    expect(prompt.split("````markdown").length).toBe(2);
  });

  it("远离的片段分开：第 6 行与第 30 行错误 → 两段片段、两对围栏", () => {
    const long = [
      MD,
      ...Array.from({ length: 14 }, (_, i) => `填充行 ${i + 16}`), // 16~29
      ":::tipl 又一个未注册指令", // 30
    ].join("\n");
    const prompt = buildFixPrompt([
      file({
        markdown: long,
        issues: [ERROR_AT_6, { ...WARNING_AT_12, line: 30 }],
      }),
    ]);
    expect(prompt.split("````markdown").length).toBe(3); // 两段片段 = 三段 split
    expect(prompt).toContain("  30 | :::tipl 又一个未注册指令");
  });

  it("无路径（粘贴内容）标注「粘贴内容（无文件路径）」", () => {
    const prompt = buildFixPrompt([file({ path: "" })]);
    expect(prompt).toContain("## 粘贴内容（无文件路径）");
    expect(prompt).not.toContain("## chapter1/");
  });

  it("多文件逐文件列出：各带自己的错误列表与片段", () => {
    const prompt = buildFixPrompt([
      file({ path: "a.md", issues: [ERROR_AT_6] }),
      file({
        path: "b/讲义.md",
        issues: [{ ...WARNING_AT_12, line: 4 }],
        version: 1,
      }),
    ]);
    expect(prompt).toContain("## a.md");
    expect(prompt).toContain("## b/讲义.md");
    expect(prompt.indexOf("## a.md")).toBeLessThan(
      prompt.indexOf("## b/讲义.md"),
    );
    // v1 行号说明只出现在 v1 文件块内
    const v1Block = prompt.slice(prompt.indexOf("## b/讲义.md"));
    expect(v1Block).toContain("旧版 v1 文档");
  });

  it("片段总行数超 200 行时截断并注明「其余 N 处错误略」（验收）", () => {
    // 40 个错误分散在 400 行文档（每 10 行一个）→ 40 个片段 × 7 行 = 280 行 > 200
    const lines: string[] = [];
    const issues: LintIssue[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(`第 ${i + 1} 行内容`);
      if ((i + 1) % 10 === 0) {
        issues.push({
          level: "error",
          line: i + 1,
          column: 1,
          code: "FILL_NO_BLANK",
          message: `第 ${i + 1} 行的问题`,
        });
      }
    }
    const markdown = lines.join("\n");
    const prompt = buildFixPrompt([file({ markdown, issues })]);

    // 截断提示出现，且数量 = 未展示的错误数（280 行 > 200：29 个片段占 203 行 → 前 28 个共 196 行展示，后 12 个略）
    expect(prompt).toMatch(
      /（其余 \d+ 处错误略：片段总行数已超过 200 行上限）/,
    );
    // 截断后不再包含被略错误的行号片段（最后一个错误行 400 不出现）
    expect(prompt).not.toContain(" 400 | 第 400 行内容");
    // 未截断的错误仍在
    expect(prompt).toContain("   7 | ");
  });

  it("原文含三反引号代码块时围栏结构不被破坏", () => {
    // 代码块拼接在 MD 之后（第 16~18 行），错误指到第 17 行 → 片段覆盖代码块
    const mdWithFence = `${MD}\n\`\`\`js\nconsole.log(1)\n\`\`\`\n`;
    const prompt = buildFixPrompt([
      file({ markdown: mdWithFence, issues: [{ ...WARNING_AT_12, line: 17 }] }),
    ]);
    expect(prompt).toContain("```js");
    // 开围栏只出现在片段前（数量与片段数一致，无额外）
    expect(prompt.split("````markdown").length).toBe(2);
  });

  it("无 issue 的文件：错误列表为（无），无片段段（防御）", () => {
    const prompt = buildFixPrompt([file({ issues: [] })]);
    expect(prompt).toContain("（无）");
    expect(prompt).not.toContain("### 相关片段");
  });
});
