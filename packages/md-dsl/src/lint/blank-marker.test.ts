import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";

/**
 * BLANK_MARKER_CONTAINS_DOLLAR 测试（测试先行：先于 blank-marker.ts 实现编写）。
 *
 * 动机（2026-10-02 实测）：填空标记 [[答案|等价答案]] 与 remark-math 的执行顺序是
 * math 先行——标记内一旦出现 $（如 [[$-\frac{5}{4}$|0.5]]），$…$ 被切成 inlineMath
 * 节点、[[ 与 ]] 分离，三连后果：① 解析器 scanStem 识别不到空位（题变无答案不判分）；
 * ② publicStemMd 剥不掉标记（答案原文随题干下发学生端，泄露红线）；③ 题干渲染残渣。
 * 正确写法：LaTeX 直接写在标记内不包 $（显示层另有启发式自动渲染）。
 * 本规则拦成 error（泄露红线，阻断导入）。
 */

const codes = (issues: readonly LintIssue[]): string[] =>
  issues.map((i) => i.code);

const issueOf = (
  issues: readonly LintIssue[],
  code: string,
): LintIssue | undefined => issues.find((i) => i.code === code);

/** 行数组拼 md */
const md = (lines: readonly string[]): string => lines.join("\n");

/** 合法练习骨架（frontmatter 占 4 行 + 空行，题目开栏落在第 6 行、题干第 7 行） */
function practiceDoc(bodyLines: readonly string[]): string {
  return md(["---", "kind: practice", "unit: 练习", "---", "", ...bodyLines]);
}

/** 合法讲义骨架（代码块负例用） */
function lectureDoc(bodyLines: readonly string[]): string {
  return md([
    "---",
    "kind: lecture",
    "unit: 专题",
    "---",
    "",
    "# 第一讲 有理数",
    "",
    ...bodyLines,
  ]);
}

describe("lintDocument：BLANK_MARKER_CONTAINS_DOLLAR", () => {
  it("samples/lint/17 反例：[[$-\\frac{5}{4}$|0.5]] 被公式切开 → error @8，并连带 FILL_NO_BLANK @7", () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../samples/lint/17-blank-marker-dollar.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const { issues } = lintDocument(fixture);
    // 标记被切开后题干没有任何完整 [[…]]，FILL_NO_BLANK 必然连带出现（同一地雷的另一面）
    expect(codes(issues)).toEqual([
      "FILL_NO_BLANK",
      "BLANK_MARKER_CONTAINS_DOLLAR",
    ]);
    const blank = issueOf(issues, "BLANK_MARKER_CONTAINS_DOLLAR");
    expect(blank).toMatchObject({ level: "error", line: 8 });
    expect(blank?.fix).toBeDefined();
    // message 要让老师「复制错误给 AI」就能改：说明泄露后果与正确写法
    expect(blank?.message).toContain("泄露");
    expect(blank?.message).toContain("$");
  });

  it("两头切开 [[$x+1$]]：同一标记只报一条（不因 ]] 侧重复报）", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "::::question{type=fill difficulty=2}",
        "设 $y=x+1$，则 $y=$ [[$x+1$]]。",
        "::::",
      ]),
    );
    expect(codes(issues)).toEqual([
      "FILL_NO_BLANK",
      "BLANK_MARKER_CONTAINS_DOLLAR",
    ]);
    const blank = issues.filter(
      (i) => i.code === "BLANK_MARKER_CONTAINS_DOLLAR",
    );
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatchObject({ level: "error", line: 7 });
  });

  it("后置等价答案写公式 [[0.5|$\\frac{1}{2}$]]：]] 侧（前兄弟是 inlineMath）报一条", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "::::question{type=fill difficulty=2}",
        "写等价形式：$0.5=$ [[0.5|$\\frac{1}{2}$]]。",
        "::::",
      ]),
    );
    expect(codes(issues)).toEqual([
      "FILL_NO_BLANK",
      "BLANK_MARKER_CONTAINS_DOLLAR",
    ]);
    expect(issueOf(issues, "BLANK_MARKER_CONTAINS_DOLLAR")).toMatchObject({
      level: "error",
      line: 7,
    });
  });

  it("完整标记内容混入 $（未被切开）：[[2$]] → error，但不连带 FILL_NO_BLANK（标记仍被识别）", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "::::question{type=fill difficulty=1}",
        "这支笔的价格是 [[2$]]（数字加货币符号）。",
        "::::",
      ]),
    );
    expect(codes(issues)).toEqual(["BLANK_MARKER_CONTAINS_DOLLAR"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 7 });
    expect(issues[0]?.fix).toBeDefined();
  });

  it("负例：数学环境内的 [[…]] 是公式记号（区间/下标），不报", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "::::question{type=fill difficulty=2}",
        "下标记号 $a_{[[1]]}$ 与区间 $[[1,2]]$ 是公式内部记号，求 $a_{1}=$ [[-1]]。",
        "::::",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("负例：代码块与行内代码里的标记不报", () => {
    const { issues } = lintDocument(
      lectureDoc([
        "写法说明：行内代码 `[[$x$]]` 不识别为填空标记。",
        "",
        "```",
        "示例 [[$x$]] 写在代码块内，不会被公式定界符切开。",
        "```",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("负例：不含 $ 的正常标记、等价答案与紧贴公式的标记，不报", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "::::question{type=fill difficulty=2}",
        "计算 $(-3)+7=$ [[4]]；紧贴公式 $x$[[5]] 与等价写法 [[0.5|1/2]] 均正常。",
        "::::",
      ]),
    );
    expect(issues).toEqual([]);
  });
});
