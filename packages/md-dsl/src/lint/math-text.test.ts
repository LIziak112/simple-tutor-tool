import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";

/**
 * MATH_SPACING_OUTSIDE 测试（测试先行：先于 math-text.ts 实现编写）。
 *
 * 动机（2026-10-02 实例）：AI 生成的讲义把选项/小题间距写在公式之间——
 * `① $…$；\quad ② $…$`、`A. $…$ \qquad B. $…$`。在 LaTeX 里 `$…$\quad$…$`
 * 是合法排版，但本管线只有 `$…$` 内部交给 KaTeX，定界符之外是纯文本，
 * `\quad`/`\qquad` 原样显示成乱码。本规则在导入前把它拦成 warning。
 */

const codes = (issues: readonly { code: string }[]): string[] =>
  issues.map((i) => i.code);

/** 行数组拼 md */
const md = (lines: readonly string[]): string => lines.join("\n");

/** 合法讲义骨架（中间塞被测正文行） */
function lectureDoc(bodyLines: readonly string[]): string {
  return md([
    "---",
    "kind: lecture",
    "unit: 专题",
    "---",
    "",
    "# 第一讲 绝对值",
    "",
    ...bodyLines,
  ]);
}

describe("lintDocument：MATH_SPACING_OUTSIDE", () => {
  it("samples/lint/15 反例：公式之间的 \\quad / \\qquad → 每行一条 warning，落在该行", () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../samples/lint/15-math-spacing-outside.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const { issues } = lintDocument(fixture);
    expect(codes(issues)).toEqual([
      "MATH_SPACING_OUTSIDE",
      "MATH_SPACING_OUTSIDE",
    ]);
    for (const issue of issues) {
      expect(issue.level).toBe("warning");
      expect(issue.fix).toBeDefined();
    }
    // 小题行（3 处 \quad）与选项行（3 处 \qquad）各一条
    expect(issues[0]?.line).toBe(10);
    expect(issues[1]?.line).toBe(14);
  });

  it("间距命令在公式内是合法排版 → 0 issue", () => {
    const { issues } = lintDocument(
      lectureDoc([
        "$m = -3,\\quad n = 7$ 是常见写法。",
        "$$1 + (-2) = -1,\\quad 3 + (-4) = -1$$",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("行内代码里的 \\quad（文档示例场景）不误报", () => {
    const { issues } = lintDocument(
      lectureDoc(["写法说明：用 `\\quad` 可以在公式内拉开间距。"]),
    );
    expect(issues).toEqual([]);
  });

  it("普通反斜杠文本与转义标点不误报", () => {
    const { issues } = lintDocument(
      lectureDoc(["反斜杠 \\\\ 与星号 \\* 不应触发；路径 C:\\work 无关。"]),
    );
    expect(issues).toEqual([]);
  });
});
