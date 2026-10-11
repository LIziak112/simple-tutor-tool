import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { studentStemMd } from "../v2/public-stem.ts";
import { lintDocument } from "./lint.ts";

/**
 * MATH_LEFT_RIGHT_UNBALANCED 测试（测试先行：先于 math.ts 实现编写）。
 *
 * 动机（2026-09-29 实例）：AI 生成的练习把填空空格嵌进公式——一条公式断成两段
 * `$…$`、`[[6]]` 夹在中间，断点写了 `\left(`/`\right)`。KaTeX 要求 \left/\right
 * 在同一条公式内配对，两段各自解析失败，页面把 LaTeX 源码原样显示（渲染失败）。
 * 本规则在导入与修订前把这类内容阻断为error。
 */

const codes = (issues: readonly { code: string }[]): string[] =>
  issues.map((i) => i.code);

/** 行数组拼 md */
const md = (lines: readonly string[]): string => lines.join("\n");

/** 合法 fill 文档骨架（中间塞被测公式行） */
function practiceDoc(mathLines: readonly string[]): string {
  return md([
    "---",
    "kind: practice",
    "unit: 练习",
    "---",
    "",
    "::::question{type=fill difficulty=1}",
    "计算：",
    "",
    ...mathLines,
    "[[答案]]",
    "::::",
  ]);
}

describe("lintDocument：MATH_LEFT_RIGHT_UNBALANCED", () => {
  it("真实练习六第8题修正源仍为8空，公开题面不泄露答案、提示和详解", () => {
    const source = readFileSync(
      new URL(
        "../../../../docs/待处理的问题/练习六第8题修正题源.md",
        import.meta.url,
      ),
      "utf8",
    );
    const { parsed, issues } = lintDocument(
      `---\nkind: practice\nunit: 练习六\n---\n\n${source}`,
    );
    expect(issues).toEqual([]);
    const question = parsed.units[0]?.questions[0];
    expect(question?.id).toBe("p6-q8");
    expect(question?.answers?.kind).toBe("fill");
    if (question?.answers?.kind !== "fill") throw new Error("应为填空题");
    expect(question.answers.blanks).toHaveLength(8);
    const publicStem = studentStemMd(question);
    expect(publicStem).not.toContain("[[6]]");
    expect(publicStem).not.toContain("先统计负因数");
    expect(publicStem).not.toContain("易错：");
  });
  it("注释和转义反斜线内的字面 left/right 不作为定界符，其他数学warning不升级", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "$\\\\left($；",
        "$$",
        "x % \\left(",
        "$$",
        "正文 \\quad 间距。",
      ]),
    );
    expect(
      issues.some((issue) => issue.code === "MATH_LEFT_RIGHT_UNBALANCED"),
    ).toBe(false);
    expect(
      issues.find((issue) => issue.code === "MATH_SPACING_OUTSIDE")?.level,
    ).toBe("warning");
  });
  it("samples/lint/13 反例：断点 \\left(/\\right) 跨段不配对 → 两条error，均在该行", () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../samples/lint/13-math-left-right.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const { issues } = lintDocument(fixture);
    expect(codes(issues)).toEqual([
      "MATH_LEFT_RIGHT_UNBALANCED",
      "MATH_LEFT_RIGHT_UNBALANCED",
    ]);
    for (const issue of issues) {
      expect(issue.level).toBe("error");
      expect(issue.line).toBe(11);
      expect(issue.fix).toBeDefined();
    }
  });

  it("配对合法：单个、嵌套、\\left. / \\right. 空定界符、多对 → 0 issue", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "$\\left(\\frac{3}{4} \\times 8\\right) = 6$；",
        "$\\left( 1 + \\left[2 \\times 3\\right] \\right)$；",
        "$\\left. x \\right.$ 处处可导；",
        "$\\left(\\frac{1}{2}\\right) \\times \\left(-\\frac{4}{5}\\right)$。",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("\\leftarrow / \\rightarrow / \\overleftrightarrow 等其他指令名不误报", () => {
    const { issues } = lintDocument(
      practiceDoc([
        "$a \\leftarrow b$；$c \\rightarrow d$；$e \\leftrightarrow f$。",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("普通括号不配对不报（KaTeX 容忍，规则只管 \\left/\\right）", () => {
    const { issues } = lintDocument(
      practiceDoc(["$= +(\\frac{3}{4} \\times 8) = +($ 断开写法合法。"]),
    );
    expect(issues).toEqual([]);
  });

  it("行内公式 \\left 未闭合 → 一条error，message 指出未配对并给改法", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\left(\\frac{1}{2} \\times 4$。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 9 });
    expect(issues[0]?.message).toContain("\\left");
    expect(issues[0]?.message).toContain("普通括号");
  });

  it("行内公式 \\right 无配对 \\left → 一条error", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\times \\frac{5}{6}\\right) = 5$。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
    expect(issues[0]?.message).toContain("\\right");
  });

  it("数学块 $$…$$ 同样检查：\\left 不闭合 → error报在该块起始行", () => {
    const doc = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill difficulty=1}",
      "证明：",
      "",
      "$$\\left(\\frac{1}{2} + \\frac{1}{3}$$",
      "",
      "[[答案]]",
      "::::",
    ]);
    const { issues } = lintDocument(doc);
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 9 });
  });

  it("每个数学节点最多一条error（同段多个 \\left 不逐个报）", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\left( \\left( \\left($ 层层未闭合。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
  });
});
