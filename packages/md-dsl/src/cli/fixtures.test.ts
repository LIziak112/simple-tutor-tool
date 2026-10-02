import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "../lint/lint.ts";
import { exitCodeFor, type FileLintResult, renderReport } from "./report.ts";

/**
 * T1.7 验收：对 lint 反例目录 samples/lint/ 运行 CLI 的核心逻辑，得到预期输出。
 * 每个反例文件断言其覆盖的 code 出现在渲染文本中；整个目录运行有 error → 退出码 1；
 * 合法样例 samples/v2/练习样例.md → 0 issue、退出码 0。
 */

const lintDir = fileURLToPath(
  new URL("../../../../samples/lint/", import.meta.url),
);
const sampleDir = fileURLToPath(
  new URL("../../../../samples/v2/", import.meta.url),
);

/** 夹具 → 其覆盖的 lint code（与 lint.test.ts 的规则断言一致） */
const EXPECTED: Record<string, string[]> = {
  "01-missing-frontmatter.md": ["MISSING_FRONTMATTER"],
  "02-missing-kind.md": ["MISSING_KIND"],
  "03-unknown-question-type.md": [
    "INVALID_QUESTION_ATTRS",
    "UNKNOWN_QUESTION_TYPE",
  ],
  "04-choice-correct.md": ["CHOICE_NO_CORRECT", "CHOICE_MULTIPLE_CORRECT"],
  "05-fill-no-blank.md": ["FILL_NO_BLANK"],
  "06-judge-invalid-answer.md": [
    "JUDGE_INVALID_ANSWER",
    "JUDGE_MULTIPLE_MARKERS",
  ],
  "07-duplicate-question-id.md": ["DUPLICATE_QUESTION_ID"],
  "08-hint-solution-outside.md": [
    "HINT_OUTSIDE_QUESTION",
    "SOLUTION_OUTSIDE_QUESTION",
    "ANSWER_OUTSIDE_QUESTION",
  ],
  "09-unknown-directive.md": ["UNKNOWN_DIRECTIVE"],
  "10-invalid-directive-attrs.md": ["INVALID_DIRECTIVE_ATTRS"],
  "11-unclosed-container.md": ["UNCLOSED_CONTAINER"],
  "12-directive-not-allowed-here.md": ["DIRECTIVE_NOT_ALLOWED_HERE"],
  "13-math-left-right.md": ["MATH_LEFT_RIGHT_UNBALANCED"],
  "14-heading-in-container.md": ["HEADING_IN_CONTAINER"],
  "15-math-spacing-outside.md": ["MATH_SPACING_OUTSIDE"],
  "16-table-pipe-split.md": ["TABLE_CELL_PIPE_SPLIT"],
};

function lintFile(name: string, dir: string): FileLintResult {
  const issues = lintDocument(readFileSync(`${dir}${name}`, "utf8")).issues;
  return { displayPath: name, issues };
}

describe("tutor-lint：samples/lint/ 反例目录（验收 1）", () => {
  it("每个反例文件的输出包含其覆盖的 code，且整目录运行退出码 1", () => {
    const onDisk = readdirSync(lintDir).filter((name) => name.endsWith(".md"));
    expect(onDisk.sort()).toEqual(Object.keys(EXPECTED).sort());

    const results = onDisk.map((name) => lintFile(name, lintDir));
    for (const result of results) {
      for (const code of EXPECTED[result.displayPath] ?? []) {
        expect(
          renderReport([result], false),
          `${result.displayPath} 应包含 [${code}]`,
        ).toContain(`[${code}]`);
      }
    }
    expect(exitCodeFor(results)).toBe(1);
  });

  it("所有输出行都符合「文件:行:列  ERROR/WARNING  [CODE] 消息 / 缩进建议行」形态", () => {
    const results = readdirSync(lintDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => lintFile(name, lintDir));
    const lines = renderReport(results, false).split("\n");
    for (const line of lines.slice(0, -1)) {
      expect(
        /^[\w./\\-]+:\d+:\d+ {2}(ERROR|WARNING) {2}\[[A-Z][A-Z0-9_]*\] /.test(
          line,
        ) || line.startsWith("  建议："),
        `不符合输出契约：${line}`,
      ).toBe(true);
    }
  });
});

describe("tutor-lint：合法样例（验收 1 反面）", () => {
  it("samples/v2/练习样例.md → 0 issue、退出码 0", () => {
    const result = lintFile("练习样例.md", sampleDir);
    expect(renderReport([result], false)).toBe(
      "共检查 1 个文件：0 error / 0 warning",
    );
    expect(exitCodeFor([result])).toBe(0);
  });
});
