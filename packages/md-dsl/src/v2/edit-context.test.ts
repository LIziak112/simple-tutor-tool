import { describe, expect, it } from "vitest";
import { lintDocument } from "../lint/lint.ts";
import {
  LECTURE_PREFIX_LINES,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "./edit-context.ts";
import { parseDocument } from "./parse.ts";

/**
 * 单条编辑包装器测试（T1.12）：包装后可解析/可 lint、缺省 id 可复现、
 * 行号平移正确。服务端与前端共用本模块，这里锁定的是两端的共同契约。
 */

const QUESTION_MD = `::::question{type=judge difficulty=1}
$0$ 既不是正数，也不是负数。[[正确]]
::::`;

describe("wrapSingleQuestionMd", () => {
  it("包装后恰好解析出 1 题，缺省 id 按 unitId-序号 复现（questionStartNumber=order+1）", () => {
    const wrapped = wrapSingleQuestionMd("练习四", QUESTION_MD);
    const parsed = parseDocument(wrapped, {
      unitId: "练习四",
      questionStartNumber: 3,
    });
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.questions).toHaveLength(1);
    // order=2（0 起）→ 序号 3 → 缺省 id 练习四-3
    expect(parsed.units[0]?.questions[0]?.id).toBe("练习四-3");
    // sourceMd 原样切片（前后空白行不入库）
    expect(parsed.units[0]?.questions[0]?.sourceMd).toBe(QUESTION_MD);
  });

  it("unitId 含 YAML 特殊字符（引号/冒号）时包装仍可解析且缺省 id 正确", () => {
    const unitId = '单元"A":测试';
    const wrapped = wrapSingleQuestionMd(unitId, QUESTION_MD);
    const parsed = parseDocument(wrapped, {
      unitId,
      questionStartNumber: 1,
    });
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parsed.units[0]?.questions[0]?.id).toBe(`${unitId}-1`);
  });

  it("lint 包装文档：issue 行号可用 shiftLintIssuesToFragment 平移回片段坐标", () => {
    // 填空题没有任何 [[…]] 空 → FILL_NO_BLANK（error，指向题目容器起始行 = 片段第 1 行）
    const broken = `::::question{type=fill difficulty=2}
没有任何空位的填空题。
::::`;
    const wrapped = wrapSingleQuestionMd("练习四", broken);
    const { issues } = lintDocument(wrapped, { unitId: "练习四" });
    const fillIssue = issues.find((i) => i.code === "FILL_NO_BLANK");
    expect(fillIssue).toBeDefined();
    expect(fillIssue?.line).toBe(SINGLE_QUESTION_PREFIX_LINES + 1);
    const shifted = shiftLintIssuesToFragment(
      issues.filter((i) => i.code === "FILL_NO_BLANK"),
      SINGLE_QUESTION_PREFIX_LINES,
    );
    expect(shifted[0]?.line).toBe(1);
  });

  it("行号小于等于前缀行数的 issue 平移后收敛到第 1 行（不出现 0/负数）", () => {
    const shifted = shiftLintIssuesToFragment(
      [
        {
          level: "error",
          line: 1,
          column: 1,
          code: "X",
          message: "前缀内不应出现的 issue",
        },
      ],
      SINGLE_QUESTION_PREFIX_LINES,
    );
    expect(shifted[0]?.line).toBe(1);
  });
});

describe("wrapLectureMd", () => {
  const LECTURE_BODY_MD = `# 第1讲 有理数

## 正数与负数

像 $1$、$2.5$ 这样的数是正数。`;

  it("包装后恰好切出 1 篇讲义，title 取 H1 文本", () => {
    const wrapped = wrapLectureMd(LECTURE_BODY_MD);
    const parsed = parseDocument(wrapped);
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parsed.lectures).toHaveLength(1);
    expect(parsed.lectures[0]?.title).toBe("第1讲 有理数");
    // 讲义 markdown 含 H1 行（「原文是真相」）
    expect(parsed.lectures[0]?.markdown).toContain("# 第1讲 有理数");
  });

  it("无 H1 的讲义 lint 出 MISSING_HEADING（error），可平移回片段坐标", () => {
    const wrapped = wrapLectureMd("只有正文，没有标题。");
    const { issues } = lintDocument(wrapped);
    const missing = issues.find((i) => i.code === "MISSING_HEADING");
    expect(missing).toBeDefined();
    // MISSING_HEADING 指向正文起始行（frontmatter 后的空白行，即包装文档第 4 行）
    expect(missing?.line).toBe(LECTURE_PREFIX_LINES);
    const shifted = shiftLintIssuesToFragment(
      issues.filter((i) => i.code === "MISSING_HEADING"),
      LECTURE_PREFIX_LINES,
    );
    expect(shifted[0]?.line).toBe(1);
  });
});
