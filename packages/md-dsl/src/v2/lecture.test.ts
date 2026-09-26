import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type LectureHeading,
  type LintIssue,
  parsedDocumentSchema,
  type Question,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse";

/**
 * T1.4 讲义与混合文档解析测试（测试先行：先于 lecture.ts 实现编写）。
 * 夹具为长期兼容性回归样例（AGENTS.md 规则 12）。
 */

/** 官方讲义样例：恰好 2 讲，覆盖 H2/H3 层级、example/steps/fold、块级公式、tip/warning */
const lectureSamplePath = fileURLToPath(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
);
const lectureSample = readFileSync(lectureSamplePath, "utf8");
/** 官方混合样例：2 讲讲义 + 3 题（第 1 题夹在两讲之间） */
const mixedSamplePath = fileURLToPath(
  new URL("../../../../samples/v2/混合样例.md", import.meta.url),
);
const mixedSample = readFileSync(mixedSamplePath, "utf8");

const lectureParsed = parseDocument(lectureSample);
const mixedParsed = parseDocument(mixedSample);
const codes = (issues: LintIssue[]): string[] => issues.map((i) => i.code);

describe("parseDocument：讲义样例（2 讲切分）", () => {
  it("快照：完整 ParsedDocument 结构稳定", async () => {
    await expect(lectureParsed).toMatchFileSnapshot(
      fileURLToPath(
        new URL("./__snapshots__/lecture-sample.snap", import.meta.url),
      ),
    );
  });

  it("合法样例 0 issue，且输出通过内容契约校验", () => {
    expect(lectureParsed.issues).toEqual([]);
    expect(parsedDocumentSchema.safeParse(lectureParsed).success).toBe(true);
  });

  it("frontmatter 解析 kind: lecture（dsl 缺省 2）", () => {
    expect(lectureParsed.frontmatter).toEqual({ kind: "lecture", dsl: 2 });
  });

  it("2 个 H1 切成 2 篇讲义，标题取 H1 文本；讲义文档不产出单元", () => {
    expect(lectureParsed.lectures).toHaveLength(2);
    expect(lectureParsed.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    expect(lectureParsed.units).toEqual([]);
  });

  it("headings 只收 H2/H3：层级与出现顺序保持，H4 以下不进目录", () => {
    const expected1: LectureHeading[] = [
      { level: 2, text: "一、正数与负数" },
      { level: 3, text: "1. 相反意义的量" },
      { level: 3, text: "2. 有理数的分类" },
      { level: 2, text: "二、符号的正确理解" },
    ];
    const expected2: LectureHeading[] = [
      { level: 2, text: "一、数轴的概念" },
      { level: 3, text: "1. 数轴三要素" },
      { level: 2, text: "二、相反数与绝对值" },
      { level: 3, text: "1. 相反数" },
      { level: 3, text: "2. 用数轴比较大小" },
    ];
    expect(lectureParsed.lectures[0]?.headings).toEqual(expected1);
    expect(lectureParsed.lectures[1]?.headings).toEqual(expected2);
  });

  it("讲义 markdown 保留该讲全部原文（含 H1 行），不含下一讲内容", () => {
    const first = lectureParsed.lectures[0]?.markdown ?? "";
    expect(first.startsWith("# 第1讲 有理数")).toBe(true);
    // 「原文是真相」：容器指令、块级公式、行内公式原文逐字保留
    expect(first).toContain("::::example");
    expect(first).toContain(":::solution");
    expect(first).toContain("::::steps");
    expect(first).toContain(':::step{title="第 1 步：判断符号"}');
    expect(first).toContain(':::fold{title="拓展：为什么需要引入负数"}');
    expect(first).toContain(":::tip");
    expect(first).toContain(":::warning");
    expect(first).toContain("$$");
    expect(first).toContain("$+7$");
    expect(first).not.toContain("第2讲 数轴");
    const second = lectureParsed.lectures[1]?.markdown ?? "";
    expect(second.startsWith("# 第2讲 数轴")).toBe(true);
    expect(second).not.toContain("相反意义的量");
  });
});

describe("parseDocument：混合样例（讲义与题目拆分并关联）", () => {
  const unit = mixedParsed.units[0];
  const questions = unit?.questions ?? [];

  it("快照：完整 ParsedDocument 结构稳定", async () => {
    await expect(mixedParsed).toMatchFileSnapshot(
      fileURLToPath(
        new URL("./__snapshots__/mixed-sample.snap", import.meta.url),
      ),
    );
  });

  it("合法样例 0 issue，且输出通过内容契约校验", () => {
    expect(mixedParsed.issues).toEqual([]);
    expect(parsedDocumentSchema.safeParse(mixedParsed).success).toBe(true);
  });

  it("同时产出讲义与单元：2 篇讲义 + 1 个单元 3 题", () => {
    expect(mixedParsed.lectures).toHaveLength(2);
    expect(mixedParsed.units).toHaveLength(1);
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.type)).toEqual(["judge", "choice", "fill"]);
    expect(questions.map((q) => q.id)).toEqual([
      "随堂练习-1",
      "随堂练习-2",
      "随堂练习-3",
    ]);
  });

  it("题目全部进同一个单元：id 取 frontmatter.unit，topic 来自 frontmatter", () => {
    expect(unit?.id).toBe("随堂练习");
    expect(unit?.title).toBe("随堂练习");
    expect(unit?.topic).toBe("有理数与数轴");
  });

  it("unit.lectureTitle 关联到题目出现位置所处的那一讲（最后一题之前最近的 H1）", () => {
    // 第 1 题在第1讲内、第 2/3 题在第2讲内：单元关联 = 最后一题所处的「第2讲 数轴」
    expect(unit?.lectureTitle).toBe("第2讲 数轴");
  });

  it("讲义 markdown 剔除全部题目但保留其余原文：每篇仍以 H1 开头，题目前后内容都在", () => {
    const first = mixedParsed.lectures[0]?.markdown ?? "";
    expect(first.startsWith("# 第1讲 有理数")).toBe(true);
    expect(first).not.toContain("::::question");
    expect(first).not.toContain("[[错误]]");
    expect(first).toContain("## 一、正数与负数");
    expect(first).toContain("例 1");
    const second = mixedParsed.lectures[1]?.markdown ?? "";
    expect(second.startsWith("# 第2讲 数轴")).toBe(true);
    expect(second).not.toContain("::::question");
    expect(second).not.toContain("[[5]]");
    expect(second).toContain("## 一、数轴与大小比较");
    // 第 3 题位于第2讲中部：其后的小节与折叠块都保留（题目位置信息外的内容不丢失）
    expect(second).toContain("## 二、相反数与绝对值");
    expect(second).toContain(':::fold{title="拓展：绝对值的几何意义"}');
  });

  it("题目字段与单独练习解析一致：答案、提示、详解照常抽取", () => {
    const fill = questions.find((q) => q.type === "fill");
    expect(fill?.answers).toEqual({ kind: "fill", blanks: [["5"], ["-7"]] });
    expect(fill?.solutionMd).toContain("先求绝对值再取相反数");
    const choice = questions.find((q) => q.type === "choice");
    expect(choice?.answers).toEqual({ kind: "choice", index: 1 });
    expect(choice?.options?.map((o) => o.text)).toEqual([
      "$-2$",
      "$0$",
      "$-1.6$",
      "$-\\dfrac{7}{4}$",
    ]);
  });

  it("sourceMd 往返：单题片段独立重解析得到同 id/type/answers/stemMd", () => {
    expect(unit).toBeDefined();
    if (unit === undefined) return;
    questions.forEach((question: Question, index: number) => {
      const reParsed = parseDocument(question.sourceMd, {
        unitId: unit.id,
        questionStartNumber: index + 1,
      });
      const reQuestion = reParsed.units[0]?.questions[0];
      expect(reQuestion, `第 ${index + 1} 题重解析应得到该题`).toBeDefined();
      expect(reQuestion?.id).toBe(question.id);
      expect(reQuestion?.type).toBe(question.type);
      expect(reQuestion?.answers).toEqual(question.answers);
      expect(reQuestion?.stemMd).toBe(question.stemMd);
    });
  });

  it("纯函数：同输入重复调用结果一致", () => {
    expect(parseDocument(mixedSample)).toEqual(mixedParsed);
    expect(parseDocument(lectureSample)).toEqual(lectureParsed);
  });
});

describe("parseDocument：讲义与混合边界", () => {
  it("第一个 H1 之前有正文：并入第一篇讲义并记 CONTENT_BEFORE_FIRST_HEADING（warning，行号指向首行正文）", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "使用说明：本讲义适用于初一上学期。",
      "请注意课前预习。",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const issue = result.issues.find(
      (i) => i.code === "CONTENT_BEFORE_FIRST_HEADING",
    );
    expect(issue?.level).toBe("warning");
    expect(issue?.line).toBe(5);
    expect(issue?.column).toBe(1);
    // 内容不丢失：并入第一篇讲义，且 H1 之后内容照常
    expect(result.lectures[0]?.markdown).toBe(
      "使用说明：本讲义适用于初一上学期。\n请注意课前预习。\n\n# 第1讲 有理数\n\n正文。",
    );
    expect(result.lectures[0]?.title).toBe("第1讲 有理数");
  });

  it("第一个 H1 之前只有空白：无 issue，讲义从 H1 行开始", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures[0]?.markdown).toBe("# 第1讲 有理数\n\n正文。");
  });

  it("kind: lecture 出现 question：记 QUESTION_IN_LECTURE（error，建议改 mixed），题目仍进单元、讲义原文剔除该题", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
      "::::question{type=judge difficulty=1}",
      "$0$ 是正数。[[错误]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const issue = result.issues.find((i) => i.code === "QUESTION_IN_LECTURE");
    expect(issue?.level).toBe("error");
    expect(issue?.line).toBe(9);
    expect(issue?.message).toContain("mixed");
    // 不静默丢弃：题目照常解析收集进单元（导入端会因 error 拒绝）
    expect(result.units[0]?.questions).toHaveLength(1);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: false,
    });
    // 讲义照常切分，markdown 剔除题目
    expect(result.lectures[0]?.markdown).toBe("# 第1讲 有理数\n\n正文。");
  });

  it("kind: lecture 无任何 H1：记 MISSING_HEADING（error）并产出 0 篇讲义", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "只有正文，没有讲义标题。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const issue = result.issues.find((i) => i.code === "MISSING_HEADING");
    expect(issue?.level).toBe("error");
    expect(result.lectures).toEqual([]);
    expect(result.units).toEqual([]);
  });

  it("mixed 全部题目都在第一个 H1 之前：unit.lectureTitle 缺省并记 warning", () => {
    const md = [
      "---",
      "kind: mixed",
      "unit: 随堂练习",
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "$0$ 是正数。[[错误]]",
      "::::",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const issue = result.issues.find(
      (i) => i.code === "QUESTION_BEFORE_FIRST_HEADING",
    );
    expect(issue?.level).toBe("warning");
    expect(issue?.line).toBe(6);
    const unit = result.units[0];
    expect(unit?.questions).toHaveLength(1);
    expect(unit?.lectureTitle).toBeUndefined();
    expect(result.lectures[0]?.markdown).toBe("# 第1讲 有理数\n\n正文。");
  });

  it("mixed 显式 frontmatter.lecture 优先于位置推断（不触发上面的 warning）", () => {
    const md = [
      "---",
      "kind: mixed",
      "unit: 随堂练习",
      "lecture: 第0讲 预备知识",
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "$0$ 是正数。[[错误]]",
      "::::",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(codes(result.issues)).not.toContain("QUESTION_BEFORE_FIRST_HEADING");
    expect(result.units[0]?.lectureTitle).toBe("第0讲 预备知识");
  });

  it("H1 标题为空：记 EMPTY_HEADING（error），该讲不产出，其余讲不受影响", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "#",
      "",
      "正文。",
      "",
      "# 第2讲 数轴",
      "",
      "正文二。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const issue = result.issues.find((i) => i.code === "EMPTY_HEADING");
    expect(issue?.level).toBe("error");
    expect(issue?.line).toBe(5);
    expect(result.lectures.map((l) => l.title)).toEqual(["第2讲 数轴"]);
  });

  it("连续两个 H1：产出两篇讲义，空讲义（只有标题行）也成立", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 甲",
      "",
      "# 第2讲 乙",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures.map((l) => l.title)).toEqual([
      "第1讲 甲",
      "第2讲 乙",
    ]);
    expect(result.lectures[0]?.markdown).toBe("# 第1讲 甲");
    expect(result.lectures[0]?.headings).toEqual([]);
    expect(result.lectures[1]?.markdown).toBe("# 第2讲 乙\n\n正文。");
  });

  it("目录抽取：容器内部的 H2/H3 也进目录（H4 不进）", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 甲",
      "",
      "## 顶层小节",
      "",
      "#### 四级标题",
      "",
      ':::fold{title="折叠"}',
      "### 容器内小节",
      "",
      "内容。",
      ":::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures[0]?.headings).toEqual([
      { level: 2, text: "顶层小节" },
      { level: 3, text: "容器内小节" },
    ]);
  });

  it("kind: practice 中出现 H1：保持 T1.3 行为（H1 只是普通内容，无新 issue）", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      "::::question{type=judge difficulty=1}",
      "$0$ 是正数。[[错误]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: false,
    });
  });

  it("CRLF 行尾：照常切分，讲义 markdown 换行归一为 LF", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 有理数",
      "",
      "正文。",
      "",
    ].join("\r\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures[0]?.markdown).toBe("# 第1讲 有理数\n\n正文。");
  });

  it("健壮性：讲义/混合路径的恶意输入不抛异常、输出恒过契约", () => {
    const hostileInputs = [
      "---\nkind: lecture\n---\n::::question",
      "---\nkind: mixed\n---\n# \n",
      "---\nkind: lecture\n---\n#\n#\n#\n",
      "---\nkind: mixed\n---\n::::question{type=fill}\n[[1]\n::::\n# 甲\n",
      "---\r\nkind: lecture\r\n---\r\n\r\n# 甲\r\n\r\n$[[x]]$\r\n",
      "---\nkind: lecture\n---\n> 引用里的 # H1 不切分\n\n# 真·第1讲\n",
      "---\nkind: mixed\nunit: 单元\n---\n\u0000乱码??<script>alert(1)</script>]]]\n# 甲\n::::question{type=judge}\n[[正确]]\n::::\n",
      lectureSample.slice(0, Math.floor(lectureSample.length / 2)),
      mixedSample.slice(0, Math.floor(mixedSample.length / 3)),
    ];
    for (const [index, text] of hostileInputs.entries()) {
      expect(
        () => parseDocument(text),
        `输入 #${index} 不应抛异常`,
      ).not.toThrow();
      const result = parseDocument(text);
      expect(
        parsedDocumentSchema.safeParse(result).success,
        `输入 #${index} 应符合内容契约`,
      ).toBe(true);
    }
  });

  it("引用/容器内部的 H1 不作为切分边界（只有顶层 H1 切分）", () => {
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 第1讲 甲",
      "",
      "> 引用里出现的「# 第2讲」只是普通内容",
      "",
      ':::fold{title="折叠"}',
      "# 第3讲 数轴",
      "",
      "内容。",
      ":::",
      "",
      "正文继续属于第1讲。",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.lectures).toHaveLength(1);
    expect(result.lectures[0]?.title).toBe("第1讲 甲");
    expect(result.lectures[0]?.markdown).toContain("正文继续属于第1讲。");
  });
});
