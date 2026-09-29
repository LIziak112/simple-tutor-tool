import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";

/**
 * MATH_LEFT_RIGHT_UNBALANCED 测试（测试先行：先于 math.ts 实现编写）。
 *
 * 动机（2026-09-29 实例）：AI 生成的练习把填空空格嵌进公式——一条公式断成两段
 * `$…$`、`[[6]]` 夹在中间，断点写了 `\left(`/`\right)`。KaTeX 要求 \left/\right
 * 在同一条公式内配对，两段各自解析失败，页面把 LaTeX 源码原样显示（渲染失败）。
 * 本规则在导入前把这类内容拦成 warning。
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
  it("samples/lint/13 反例：断点 \\left(/\\right) 跨段不配对 → 两条 warning，均在该行", () => {
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
      expect(issue.level).toBe("warning");
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

  it("行内公式 \\left 未闭合 → 一条 warning，message 指出未配对并给改法", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\left(\\frac{1}{2} \\times 4$。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
    expect(issues[0]).toMatchObject({ level: "warning", line: 9 });
    expect(issues[0]?.message).toContain("\\left");
    expect(issues[0]?.message).toContain("普通括号");
  });

  it("行内公式 \\right 无配对 \\left → 一条 warning", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\times \\frac{5}{6}\\right) = 5$。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
    expect(issues[0]?.message).toContain("\\right");
  });

  it("数学块 $$…$$ 同样检查：\\left 不闭合 → warning 报在该块起始行", () => {
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
    expect(issues[0]).toMatchObject({ level: "warning", line: 9 });
  });

  it("每个数学节点最多一条 warning（同段多个 \\left 不逐个报）", () => {
    const { issues } = lintDocument(
      practiceDoc(["$\\left( \\left( \\left($ 层层未闭合。"]),
    );
    expect(codes(issues)).toEqual(["MATH_LEFT_RIGHT_UNBALANCED"]);
  });
});
