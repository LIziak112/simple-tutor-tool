import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type LintIssue, lintIssueSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint";

/**
 * T1.5 linter 测试（测试先行：先于 lint/ 实现编写）。
 * 夹具：samples/lint/ 每条规则一个反例文件；samples/v2/ 三份合法样例 0 issue（夹具质量回归）。
 */

const lintDir = "../../../../samples/lint/";
const sampleDir = "../../../../samples/v2/";

function load(...segments: string[]): string {
  return readFileSync(
    fileURLToPath(new URL([...segments].join("/"), import.meta.url)),
    "utf8",
  );
}

const codes = (issues: readonly LintIssue[]): string[] =>
  issues.map((i) => i.code);
const issueOf = (
  issues: readonly LintIssue[],
  code: string,
): LintIssue | undefined => issues.find((i) => i.code === code);

/** 行数组拼 md，便于按行号断言 */
const md = (lines: readonly string[]): string => lines.join("\n");

describe("lintDocument：samples/lint/ 反例夹具", () => {
  it("01 缺 frontmatter：MISSING_FRONTMATTER @1，无误报", () => {
    const { issues } = lintDocument(load(lintDir, "01-missing-frontmatter.md"));
    expect(codes(issues)).toEqual(["MISSING_FRONTMATTER"]);
    expect(issueOf(issues, "MISSING_FRONTMATTER")).toMatchObject({
      level: "error",
      line: 1,
    });
  });

  it("02 缺 kind：MISSING_KIND @2（围栏行+1），无误报", () => {
    const { issues } = lintDocument(load(lintDir, "02-missing-kind.md"));
    expect(codes(issues)).toEqual(["MISSING_KIND"]);
    expect(issueOf(issues, "MISSING_KIND")).toMatchObject({
      level: "error",
      line: 2,
    });
  });

  it("03 未知题型：透传 INVALID_QUESTION_ATTRS 与 UNKNOWN_QUESTION_TYPE，均在题目开栏行", () => {
    const { issues } = lintDocument(
      load(lintDir, "03-unknown-question-type.md"),
    );
    expect(codes(issues)).toEqual([
      "INVALID_QUESTION_ATTRS",
      "UNKNOWN_QUESTION_TYPE",
    ]);
    for (const issue of issues) {
      expect(issue.line).toBe(7);
      expect(issue.level).toBe("error");
    }
  });

  it("04 选择题正确项：CHOICE_NO_CORRECT @8/@24，CHOICE_MULTIPLE_CORRECT @16", () => {
    const { issues } = lintDocument(load(lintDir, "04-choice-correct.md"));
    expect(issues).toHaveLength(3);
    expect(issueOf(issues, "CHOICE_NO_CORRECT")).toMatchObject({
      line: 7,
      level: "error",
    });
    expect(issueOf(issues, "CHOICE_MULTIPLE_CORRECT")).toMatchObject({
      line: 15,
      level: "error",
    });
    const lines = codes(issues);
    expect(lines.filter((c) => c === "CHOICE_NO_CORRECT")).toHaveLength(2);
    expect(issueOf(issues.slice(1), "CHOICE_NO_CORRECT")?.line).toBe(23);
    // 多个 [x] 的 message 列出行号，方便「复制错误给 AI」修正
    expect(issueOf(issues, "CHOICE_MULTIPLE_CORRECT")?.message).toContain("18");
  });

  it("05 填空无空：FILL_NO_BLANK @8", () => {
    const { issues } = lintDocument(load(lintDir, "05-fill-no-blank.md"));
    expect(codes(issues)).toEqual(["FILL_NO_BLANK"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 7 });
    expect(issues[0]?.fix).toBeDefined();
  });

  it("06 判断题：JUDGE_INVALID_ANSWER @9（[[对]]），JUDGE_MULTIPLE_MARKERS @18（第二个标记）", () => {
    const { issues } = lintDocument(
      load(lintDir, "06-judge-invalid-answer.md"),
    );
    expect(issues).toHaveLength(2);
    expect(issueOf(issues, "JUDGE_INVALID_ANSWER")).toMatchObject({
      level: "error",
      line: 8,
    });
    expect(issueOf(issues, "JUDGE_INVALID_ANSWER")?.fix).toContain("[[正确]]");
    expect(issueOf(issues, "JUDGE_MULTIPLE_MARKERS")).toMatchObject({
      level: "warning",
      line: 17,
    });
  });

  it("07 题目 id 重复：DUPLICATE_QUESTION_ID @12（后出现的题），message 指出首次出现行", () => {
    const { issues } = lintDocument(
      load(lintDir, "07-duplicate-question-id.md"),
    );
    expect(codes(issues)).toEqual(["DUPLICATE_QUESTION_ID"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 11 });
    expect(issues[0]?.message).toContain("q1");
    expect(issues[0]?.message).toContain("7");
  });

  it("08 hint/solution/answer 在题目外：@12/@16/@20，均 error", () => {
    const { issues } = lintDocument(
      load(lintDir, "08-hint-solution-outside.md"),
    );
    expect(codes(issues)).toEqual([
      "HINT_OUTSIDE_QUESTION",
      "SOLUTION_OUTSIDE_QUESTION",
      "ANSWER_OUTSIDE_QUESTION",
    ]);
    expect(issues[0]?.line).toBe(11);
    expect(issues[1]?.line).toBe(15);
    expect(issues[2]?.line).toBe(19);
    for (const issue of issues) expect(issue.level).toBe("error");
  });

  it("09 未注册指令：@11/@16/@18 均 warning，近似名建议 tps→tip、hints→hint、boxx→box", () => {
    const { issues } = lintDocument(load(lintDir, "09-unknown-directive.md"));
    expect(issues).toHaveLength(3);
    expect(issueOf(issues, "UNKNOWN_DIRECTIVE")).toMatchObject({
      level: "warning",
      line: 10,
    });
    expect(issueOf(issues, "UNKNOWN_DIRECTIVE")?.message).toContain(":::tip");
    const second = issues.find((i) => i.line === 15);
    expect(second?.code).toBe("UNKNOWN_DIRECTIVE");
    expect(second?.message).toContain("::hint");
    const third = issues.find((i) => i.line === 17);
    expect(third?.code).toBe("UNKNOWN_DIRECTIVE");
    expect(third?.message).toContain(":::box");
  });

  it("10 属性校验：image 缺 src @9 为 error；fold 未知属性 titel @11 为 warning 且建议 title", () => {
    const { issues } = lintDocument(
      load(lintDir, "10-invalid-directive-attrs.md"),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      code: "INVALID_DIRECTIVE_ATTRS",
      level: "error",
      line: 8,
    });
    expect(issues[0]?.message).toContain("src");
    expect(issues[1]).toMatchObject({
      code: "INVALID_DIRECTIVE_ATTRS",
      level: "warning",
      line: 10,
    });
    expect(issues[1]?.message).toContain("titel");
    expect(issues[1]?.message).toContain("title");
  });

  it("11 未闭合容器：UNCLOSED_CONTAINER @8，error", () => {
    const { issues } = lintDocument(load(lintDir, "11-unclosed-container.md"));
    expect(codes(issues)).toEqual(["UNCLOSED_CONTAINER"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 8 });
    expect(issues[0]?.message).toContain("warning");
    expect(issues[0]?.fix).toBeDefined();
  });

  it("12 指令位置：example 出现在 question 内 → DIRECTIVE_NOT_ALLOWED_HERE @11 warning", () => {
    const { issues } = lintDocument(
      load(lintDir, "12-directive-not-allowed-here.md"),
    );
    expect(codes(issues)).toEqual(["DIRECTIVE_NOT_ALLOWED_HERE"]);
    expect(issues[0]).toMatchObject({ level: "warning", line: 10 });
    expect(issues[0]?.message).toContain("example");
  });

  it("13 公式 \\left/\\right 跨段不配对：MATH_LEFT_RIGHT_UNBALANCED @11 ×2 warning，无误报", () => {
    const { issues } = lintDocument(load(lintDir, "13-math-left-right.md"));
    expect(codes(issues)).toEqual([
      "MATH_LEFT_RIGHT_UNBALANCED",
      "MATH_LEFT_RIGHT_UNBALANCED",
    ]);
    for (const issue of issues) {
      expect(issue.level).toBe("warning");
      expect(issue.line).toBe(11);
    }
  });

  it("14 折叠/逐步揭晓容器内的 H2/H3：HEADING_IN_CONTAINER @11 与 @21 error，H4 与容器外不报", () => {
    const { issues } = lintDocument(
      load(lintDir, "14-heading-in-container.md"),
    );
    expect(codes(issues)).toEqual([
      "HEADING_IN_CONTAINER",
      "HEADING_IN_CONTAINER",
    ]);
    expect(issues[0]).toMatchObject({ level: "error", line: 11 });
    expect(issues[0]?.message).toContain("fold");
    expect(issues[1]).toMatchObject({ level: "error", line: 21 });
    expect(issues[1]?.message).toContain("step");
    for (const issue of issues) expect(issue.fix).toBeDefined();
  });

  it("14b question/columns 内的 H2/H3 不报（题目容器内容另行抽取、始终渲染）", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: practice",
        "---",
        "",
        "::::question{type=solve}",
        "计算。",
        "",
        ":::columns",
        "## 列内标题（columns 始终渲染，不报）",
        ":::",
        "::::",
      ]),
    );
    expect(codes(issues).filter((c) => c === "HEADING_IN_CONTAINER")).toEqual(
      [],
    );
  });

  it("全部夹具的 issue 均符合 LintIssue 契约（level/line/column/code/message）", () => {
    for (const name of [
      "01-missing-frontmatter.md",
      "02-missing-kind.md",
      "03-unknown-question-type.md",
      "04-choice-correct.md",
      "05-fill-no-blank.md",
      "06-judge-invalid-answer.md",
      "07-duplicate-question-id.md",
      "08-hint-solution-outside.md",
      "09-unknown-directive.md",
      "10-invalid-directive-attrs.md",
      "11-unclosed-container.md",
      "12-directive-not-allowed-here.md",
      "13-math-left-right.md",
      "14-heading-in-container.md",
      "15-math-spacing-outside.md",
      "16-table-pipe-split.md",
      "17-blank-marker-dollar.md",
    ]) {
      const { issues } = lintDocument(load(lintDir, name));
      for (const issue of issues) {
        expect(
          lintIssueSchema.safeParse(issue).success,
          `${name} ${issue.code}`,
        ).toBe(true);
      }
    }
  });
});

describe("lintDocument：合法样例 0 issue（夹具质量回归）", () => {
  it.each([
    ["练习样例.md", "practice"],
    ["讲义样例.md", "lecture"],
    ["混合样例.md", "mixed"],
  ] as const)("samples/v2/%s（kind=%s）issues 为空", (name, kind) => {
    const { parsed, issues } = lintDocument(load(sampleDir, name));
    expect(issues).toEqual([]);
    expect(parsed.frontmatter?.kind).toBe(kind);
  });
});

describe("lintDocument：解析层 issue 透传与合并", () => {
  it("透传不重复报：未知题型只出现一次 UNKNOWN_QUESTION_TYPE / INVALID_QUESTION_ATTRS", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=essay}",
      "写一篇作文。",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(
      codes(issues).filter((c) => c === "UNKNOWN_QUESTION_TYPE"),
    ).toHaveLength(1);
    expect(
      codes(issues).filter((c) => c === "INVALID_QUESTION_ATTRS"),
    ).toHaveLength(1);
  });

  it("解析层与规则层 issue 合并后按（行、列、code）稳定排序", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      ":::hint",
      "游离提示",
      ":::",
      "",
      "::::question{type=essay}",
      "作文题",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    // 规则层的 HINT_OUTSIDE_QUESTION（第 6 行）排在解析层 issue（第 10 行）之前
    expect(codes(issues)).toEqual([
      "HINT_OUTSIDE_QUESTION",
      "INVALID_QUESTION_ATTRS",
      "UNKNOWN_QUESTION_TYPE",
    ]);
    expect(issues[0]?.line).toBe(6);
  });

  it("parsed.issues 与顶层 issues 同步为完整合并结果", () => {
    const text = load(lintDir, "04-choice-correct.md");
    const { parsed, issues } = lintDocument(text);
    expect(parsed.issues).toEqual(issues);
  });

  it("纯函数：同输入重复调用结果一致", () => {
    const text = load(lintDir, "06-judge-invalid-answer.md");
    expect(lintDocument(text)).toEqual(lintDocument(text));
  });
});

describe("lintDocument：ParseOptions 透传（导入分析传入文件名场景，方案 §7 第 3 步）", () => {
  const noUnit = md([
    "---",
    "kind: practice",
    "---",
    "",
    "::::question{type=judge difficulty=1}",
    "$0$ 是正数。[[错误]]",
    "::::",
  ]);

  it("lintDocument(md, {fallbackUnitId}) 的 options 透传到 parseDocument：单元锚定文件名并出现 UNIT_FROM_FALLBACK", () => {
    const { parsed, issues } = lintDocument(noUnit, {
      fallbackUnitId: "有理数练习",
    });
    expect(parsed.units[0]?.id).toBe("有理数练习");
    expect(codes(issues)).toContain("UNIT_FROM_FALLBACK");
    expect(issueOf(issues, "UNIT_FROM_FALLBACK")?.level).toBe("warning");
  });

  it("不传 options：行为与现状一致（兜底字面量、无 UNIT_FROM_FALLBACK）", () => {
    const { parsed, issues } = lintDocument(noUnit);
    expect(parsed.units[0]?.id).toBe("unit");
    expect(issues).toEqual([]);
  });
});

describe("lintDocument：题目规则补充", () => {
  it("选择题题干完全没有选项：CHOICE_NO_CORRECT，message 提示补任务列表", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=choice difficulty=1}",
      "选一个最合适的。",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["CHOICE_NO_CORRECT"]);
    expect(issues[0]?.line).toBe(6);
    expect(issues[0]?.message).toContain("选项");
  });

  it("多选题多个正确项合法：0 issue", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=multi difficulty=2}",
      "选。",
      "",
      "- [x] 甲",
      "- [x] 乙",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(issues).toEqual([]);
  });

  it("填空题只写了空标记 [[ ]]：解析层已报 INVALID_BLANK_MARKER，linter 不再重复报 FILL_NO_BLANK", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill}",
      "补全：[[ ]]。",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["INVALID_BLANK_MARKER"]);
  });

  it("判断题只写了空标记 [[ ]]：同上不重复报 JUDGE_INVALID_ANSWER", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge}",
      "判断。[[ ]]",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["INVALID_BLANK_MARKER"]);
  });

  it("判断题完全没有标记：JUDGE_INVALID_ANSWER 报在题目开栏行", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "$1$ 是正数。",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["JUDGE_INVALID_ANSWER"]);
    expect(issues[0]?.line).toBe(6);
  });

  it("显式 id 与缺省 id 冲突：DUPLICATE_QUESTION_ID 报在后一题（缺省生成那题）", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge id=练习-2}",
      "一。[[正确]]",
      "::::",
      "",
      "::::question{type=judge}",
      "二。[[正确]]",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["DUPLICATE_QUESTION_ID"]);
    expect(issues[0]?.line).toBe(10);
    expect(issues[0]?.message).toContain("练习-2");
    expect(issues[0]?.message).toContain("6");
  });
});

describe("lintDocument：指令规则补充", () => {
  it("无相近候选的未知指令：提示查规范文档，不给 fix", () => {
    const text = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::zzzzzz",
      "x",
      ":::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["UNKNOWN_DIRECTIVE"]);
    expect(issues[0]?.message).toContain("规范");
    expect(issues[0]?.message).not.toContain("你是不是想用");
    expect(issues[0]?.fix).toBeUndefined();
  });

  it("step 出现在 steps 之外：DIRECTIVE_NOT_ALLOWED_HERE", () => {
    const text = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ':::step{title="第 1 步"}',
      "内容",
      ":::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["DIRECTIVE_NOT_ALLOWED_HERE"]);
    expect(issues[0]).toMatchObject({ level: "warning", line: 7 });
    expect(issues[0]?.message).toContain("steps");
  });

  it("col 出现在 columns 之外：DIRECTIVE_NOT_ALLOWED_HERE", () => {
    const text = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::col",
      "内容",
      ":::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["DIRECTIVE_NOT_ALLOWED_HERE"]);
    expect(issues[0]?.line).toBe(7);
  });

  it(":mark 出现在 :::steps 内：祖先链命中 lecture，合法（0 issue）", () => {
    const text = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      "::::steps",
      ':::step{title="第 1 步"}',
      "看 :mark[这里]{color=red}。",
      ":::",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(issues).toEqual([]);
  });

  it("hint / solution 在讲义正文合法（0 issue）；answer 在讲义报 ANSWER_OUTSIDE_QUESTION", () => {
    const hintInLecture = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::hint",
      "提示内容",
      ":::",
    ]);
    expect(lintDocument(hintInLecture).issues).toEqual([]);

    const solutionInLecture = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::solution",
      "解析内容",
      ":::",
    ]);
    expect(lintDocument(solutionInLecture).issues).toEqual([]);

    const answerInLecture = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::answer",
      "42",
      ":::",
    ]);
    const { issues } = lintDocument(answerInLecture);
    expect(codes(issues)).toEqual(["ANSWER_OUTSIDE_QUESTION"]);
    expect(issues[0]).toMatchObject({ level: "error", line: 7 });
  });

  it("mixed 讲义段落中的 solution 合法（0 issue）", () => {
    const text = md([
      "---",
      "kind: mixed",
      "unit: 随堂练习",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::solution",
      "解析内容",
      ":::",
    ]);
    expect(lintDocument(text).issues).toEqual([]);
  });

  it("fold 出现在 question 内：DIRECTIVE_NOT_ALLOWED_HERE（fold 仅讲义正文可用）", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=solve difficulty=3}",
      "计算。",
      "",
      ':::fold{title="拓展"}',
      "内容",
      ":::",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toEqual(["DIRECTIVE_NOT_ALLOWED_HERE"]);
    expect(issues[0]?.line).toBe(9);
  });

  it("question 嵌套在 question 内：DIRECTIVE_NOT_ALLOWED_HERE；外层判断题同时报多标记 warning", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge}",
      "外层题。[[正确]]",
      "",
      "::::question{type=judge}",
      "内层题。[[错误]]",
      "::::",
      "::::",
    ]);
    const { issues } = lintDocument(text);
    expect(codes(issues)).toContain("DIRECTIVE_NOT_ALLOWED_HERE");
    expect(issueOf(issues, "DIRECTIVE_NOT_ALLOWED_HERE")?.line).toBe(9);
    expect(issueOf(issues, "JUDGE_MULTIPLE_MARKERS")?.line).toBe(10);
  });

  it("属性补充：graph 缺 fn error；mark color 非法 warning；image src 空串 error；fold title 空串 error", () => {
    const graphMissingFn = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      '::graph{range="-3,3"}',
    ]);
    const graphIssues = lintDocument(graphMissingFn).issues;
    expect(codes(graphIssues)).toEqual(["INVALID_DIRECTIVE_ATTRS"]);
    expect(graphIssues[0]).toMatchObject({ level: "error", line: 7 });
    expect(graphIssues[0]?.message).toContain("fn");

    const markBadColor = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      '看 :mark[这里]{color="purple"}。',
    ]);
    const markIssues = lintDocument(markBadColor).issues;
    expect(codes(markIssues)).toEqual(["INVALID_DIRECTIVE_ATTRS"]);
    expect(markIssues[0]?.level).toBe("warning");

    const imageEmptySrc = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      '::image{src=""}',
    ]);
    const imageIssues = lintDocument(imageEmptySrc).issues;
    expect(codes(imageIssues)).toEqual(["INVALID_DIRECTIVE_ATTRS"]);
    expect(imageIssues[0]?.level).toBe("error");

    const foldEmptyTitle = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      ":::fold{title}",
      "内容",
      ":::",
    ]);
    const foldIssues = lintDocument(foldEmptyTitle).issues;
    expect(codes(foldIssues)).toEqual(["INVALID_DIRECTIVE_ATTRS"]);
    expect(foldIssues[0]?.level).toBe("error");
  });
});

describe("lintDocument：image src 前缀校验（IMAGE_SRC_NOT_BLOBS，媒体管线第一单）", () => {
  const lectureImage = (src: string): string =>
    md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      `::image{src="${src}"}`,
    ]);

  it("外链 URL：warning，报在指令行，message/fix 指引上传并使用 blobs/media/ 路径", () => {
    const { issues } = lintDocument(
      lectureImage("https://cdn.example.com/fig.png"),
    );
    expect(codes(issues)).toEqual(["IMAGE_SRC_NOT_BLOBS"]);
    expect(issues[0]).toMatchObject({ level: "warning", line: 7, column: 1 });
    expect(issues[0]?.message).toContain("blobs/media/");
    expect(issues[0]?.message).toContain("外链");
    expect(issues[0]?.fix).toContain("blobs/media/");
  });

  it("非 blobs/ 开头的相对散路径：同样 warning", () => {
    const { issues } = lintDocument(lectureImage("images/fig-1.png"));
    expect(codes(issues)).toEqual(["IMAGE_SRC_NOT_BLOBS"]);
    expect(issues[0]?.level).toBe("warning");
  });

  it("blobs/ 前缀不触发：旧式 blobs/fig-1.png 与新式 blobs/media/<64 位哈希>.png 均 0 issue", () => {
    expect(lintDocument(lectureImage("blobs/fig-1.png")).issues).toEqual([]);
    expect(
      lintDocument(lectureImage(`blobs/media/${"9af3".padEnd(64, "0")}.png`))
        .issues,
    ).toEqual([]);
  });

  it("缺 src 只报 INVALID_DIRECTIVE_ATTRS error，不双报 IMAGE_SRC_NOT_BLOBS", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: lecture",
        "---",
        "",
        "# 第1讲 有理数",
        "",
        '::image{width="60%"}',
      ]),
    );
    expect(codes(issues)).toEqual(["INVALID_DIRECTIVE_ATTRS"]);
    expect(issues[0]?.level).toBe("error");
  });

  it("题目内（question 语境）的 image 同样受校验", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: practice",
        "unit: 练习",
        "---",
        "",
        "::::question{type=solve}",
        '::image{src="https://example.com/a.png"}',
        "::::",
      ]),
    );
    expect(codes(issues)).toEqual(["IMAGE_SRC_NOT_BLOBS"]);
    expect(issues[0]?.level).toBe("warning");
  });
});

describe("lintDocument：未闭合容器补充", () => {
  it("未闭合 question 会吞掉后续内容：栈内每个未闭合容器各报一条 UNCLOSED_CONTAINER", () => {
    const text = md([
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill}",
      "计算：$1+1=$ [[2]]",
      "",
      ":::hint",
      "先想想。",
    ]);
    const { issues, parsed } = lintDocument(text);
    expect(codes(issues)).toEqual(["UNCLOSED_CONTAINER", "UNCLOSED_CONTAINER"]);
    expect(issues[0]?.line).toBe(6);
    expect(issues[1]?.line).toBe(9);
    // 解析层「尽量产出」：未闭合的 question 仍是顶层节点，题被解析（含其内部 hint；
    // 注意未闭合容器的最后一行内容会被既有切片逻辑截去，属 T1.3 行为，本 error 已阻断导入）
    expect(parsed.units[0]?.questions).toHaveLength(1);
    expect(parsed.units[0]?.questions[0]?.hints).toHaveLength(1);
  });

  it("代码块里的 ::: 不误报未闭合", () => {
    const text = md([
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      "示例写法：",
      "",
      "```",
      ":::tip",
      "```",
      "",
      ':::tip{title="真容器"}',
      "内容",
      ":::",
    ]);
    const { issues } = lintDocument(text);
    expect(issues).toEqual([]);
  });
});
