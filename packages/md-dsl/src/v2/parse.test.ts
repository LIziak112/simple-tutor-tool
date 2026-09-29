import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type LintIssue,
  parsedDocumentSchema,
  type Question,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse";

/** 官方练习样例（兼容性回归夹具，AGENTS.md 规则 12）：覆盖全部七种题型 */
const samplePath = fileURLToPath(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
);
const sample = readFileSync(samplePath, "utf8");
const snapshotPath = fileURLToPath(
  new URL("./__snapshots__/practice-sample.snap", import.meta.url),
);

const parsed = parseDocument(sample);
const unit = parsed.units[0];
const questions = unit?.questions ?? [];
const byType = (type: Question["type"]): Question | undefined =>
  questions.find((q) => q.type === type);
const codes = (issues: LintIssue[]): string[] => issues.map((i) => i.code);

describe("parseDocument：练习样例（七种题型全覆盖）", () => {
  it("快照：完整 ParsedDocument 结构稳定", async () => {
    await expect(parsed).toMatchFileSnapshot(snapshotPath);
  });

  it("合法样例 0 issue，且输出通过内容契约校验", () => {
    expect(parsed.issues).toEqual([]);
    expect(parsedDocumentSchema.safeParse(parsed).success).toBe(true);
  });

  it("frontmatter：kind/dsl 缺省值/unit/lecture/topic 全部解析", () => {
    expect(parsed.frontmatter).toEqual({
      kind: "practice",
      dsl: 2,
      unit: "练习四",
      lecture: "第4讲",
      topic: "有理数加减混合",
    });
  });

  it("八个题目覆盖全部七种题型，单元字段正确", () => {
    expect(unit?.id).toBe("练习四");
    expect(unit?.title).toBe("练习四");
    expect(unit?.topic).toBe("有理数加减混合");
    expect(unit?.lectureTitle).toBe("第4讲");
    expect(questions).toHaveLength(8);
    expect(new Set(questions.map((q) => q.type))).toEqual(
      new Set([
        "judge",
        "choice",
        "multi",
        "fill",
        "solve",
        "apply",
        "find-error",
      ]),
    );
  });

  it("题目 id：缺省 id 为「单元-序号」，显式 id 属性优先，序号按文档出现顺序", () => {
    expect(questions.map((q) => q.id)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-3",
      "练习四-4",
      "练习四-5",
      "p4-q7",
      "练习四-7",
      "练习四-8",
    ]);
  });

  it("填空：空数与答案数一致，等价答案按竖线拆分", () => {
    const fillQuestions = questions.filter((q) => q.type === "fill");
    expect(fillQuestions).toHaveLength(2);
    const first = fillQuestions[0]?.answers;
    expect(first?.kind).toBe("fill");
    // 题干 3 个 [[…]] 标记 ↔ 3 组答案，且 [[0.5|1/2]] 拆为等价答案
    if (first?.kind === "fill") {
      expect(first.blanks).toEqual([["4"], ["-7"], ["0.5", "1/2"]]);
    }
  });

  it("填空：$…$ 数学公式内的 [[…]] 不识别为空", () => {
    const second = questions
      .filter((q) => q.type === "fill")
      .map((q) => q.answers)
      .at(1);
    // 题干里 $a_{[[1]]}$、$a_{[[2]]}$ 在公式内，只有题干末尾的 [[-3]] 是空
    expect(second).toEqual({ kind: "fill", blanks: [["-3"]] });
  });

  it("判断题：[[正确]] 映射为 value: true，solution 收进 solutionMd", () => {
    expect(byType("judge")?.answers).toEqual({ kind: "judge", value: true });
    expect(byType("judge")?.solutionMd).toContain("正数与负数的分界点");
  });

  it("选择题：[x] 为正确项，下标与选项对齐，选项保留 markdown 原文", () => {
    const choice = byType("choice");
    expect(choice?.options?.map((o) => o.correct)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(choice?.answers).toEqual({ kind: "choice", index: 1 });
    expect(choice?.options?.[0]?.text).toBe("$-5$");
    expect(choice?.options?.[2]?.text).toBe("$\\frac{1}{5}$");
  });

  it("多选题：全部 [x] 项下标收进 indexes", () => {
    const multi = byType("multi");
    expect(multi?.options?.map((o) => o.correct)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(multi?.answers).toEqual({ kind: "multi", indexes: [0, 2] });
  });

  it("solve：:::answer 收进 answers.final，difficulty/考点属性解析", () => {
    const solve = byType("solve");
    expect(solve?.id).toBe("p4-q7");
    expect(solve?.difficulty).toBe(3);
    expect(solve?.knowledge).toEqual(["有理数混合运算"]);
    expect(solve?.answers).toEqual({ kind: "final", answer: "-3" });
  });

  it("apply/find-error：hint 可多个且保持出现顺序，answer 为最终答案", () => {
    const findError = byType("find-error");
    expect(findError?.hints).toHaveLength(2);
    expect(findError?.hints?.[0]).toContain("异号两数相加");
    expect(findError?.hints?.[1]).toContain("逐项检查");
    expect(findError?.answers?.kind).toBe("final");
    expect(findError?.stemMd).toContain("第一步");
  });

  it("题干 stemMd 保留原文（含 [[答案]] 标记），不含 hint/answer/solution 内容", () => {
    const fill = questions[3];
    expect(fill?.stemMd).toContain("[[0.5|1/2]]");
    expect(fill?.stemMd).not.toContain("同号相加");
    expect(fill?.stemMd).not.toContain("dfrac");
  });

  it("sourceMd 往返：单题片段独立重解析得到同 id/type/answers/stemMd/hints/options", () => {
    expect(unit).toBeDefined();
    if (unit === undefined) return;
    questions.forEach((question, index) => {
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
      expect(reQuestion?.hints).toEqual(question.hints);
      expect(reQuestion?.options).toEqual(question.options);
    });
  });

  it("纯函数：同输入重复调用结果一致", () => {
    expect(parseDocument(sample)).toEqual(parsed);
  });
});

describe("parseDocument：健壮性（纯函数不抛异常）", () => {
  const hostileInputs = [
    "",
    "\n\n\n",
    "---\n---\n",
    "---\nkind: practice\n",
    "::::question",
    "::::question{type=fill}\n[[1]\n::::",
    "$$$$[[1]]$$",
    "::::question{type=judge}\n[[正确]]",
    "\u0000\uFFFF随机乱码???<script>alert(1)</script>]]][[[",
    sample.slice(0, Math.floor(sample.length / 2)),
  ];

  it.each(hostileInputs.map((text, i) => [`输入 #${i}`, text] as const))(
    "不抛异常：%s",
    (_name, text) => {
      expect(() => parseDocument(text)).not.toThrow();
      const result = parseDocument(text);
      expect(parsedDocumentSchema.safeParse(result).success).toBe(true);
      expect(Array.isArray(result.issues)).toBe(true);
    },
  );

  it("空文档：记 MISSING_FRONTMATTER issue，无单元无题目", () => {
    const result = parseDocument("");
    expect(codes(result.issues)).toContain("MISSING_FRONTMATTER");
    expect(result.frontmatter).toBeUndefined();
    expect(result.units).toEqual([]);
  });

  it("坏 YAML：记 INVALID_FRONTMATTER_YAML，行号指向出错行，题目仍尽量解析", () => {
    const md =
      "---\nkind: practice\nunit: [未闭合\n---\n\n::::question{type=judge}\n$0$ 是正数。[[错误]]\n::::\n";
    const result = parseDocument(md);
    expect(codes(result.issues)).toContain("INVALID_FRONTMATTER_YAML");
    const yamlIssue = result.issues.find(
      (i) => i.code === "INVALID_FRONTMATTER_YAML",
    );
    expect(yamlIssue?.line).toBe(3);
    expect(result.frontmatter).toBeUndefined();
    // frontmatter 解析失败但题目照常产出，缺省单元 id 落到兜底值
    expect(result.units[0]?.questions).toHaveLength(1);
    expect(result.units[0]?.id).toBe("unit");
    expect(result.units[0]?.questions[0]?.id).toBe("unit-1");
  });

  it("kind 缺失：记 MISSING_KIND；kind 非法：记 INVALID_KIND", () => {
    const missing = parseDocument("---\nunit: 练习\n---\n");
    expect(codes(missing.issues)).toContain("MISSING_KIND");
    expect(missing.frontmatter).toBeUndefined();

    const invalid = parseDocument("---\nkind: notes\n---\n");
    expect(codes(invalid.issues)).toContain("INVALID_KIND");
    expect(invalid.frontmatter).toBeUndefined();
  });

  it("frontmatter 不是映射表：记 INVALID_FRONTMATTER", () => {
    const result = parseDocument("---\n- 只是\n- 列表\n---\n");
    expect(codes(result.issues)).toContain("INVALID_FRONTMATTER");
  });

  it("未知题型（essay）：记 UNKNOWN_QUESTION_TYPE，该题不入库但不影响后续题（序号仍占位）", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=essay difficulty=2}",
      "写一篇作文。",
      "::::",
      "",
      "::::question{type=judge difficulty=1}",
      "$0$ 是负数。[[错误]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(codes(result.issues)).toContain("UNKNOWN_QUESTION_TYPE");
    const kept = result.units[0]?.questions ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe("练习-2");
    expect(kept[0]?.answers).toEqual({ kind: "judge", value: false });
  });

  it("question 缺 type：记 MISSING_QUESTION_TYPE，该题不入库", () => {
    const md = "::::question{difficulty=2}\n没有题型的题。\n::::\n";
    const result = parseDocument(md);
    expect(codes(result.issues)).toContain("MISSING_QUESTION_TYPE");
    expect(result.units[0]?.questions ?? []).toHaveLength(0);
  });

  it("属性校验失败：difficulty 越界回退缺省 2，未知属性名不致命，题目仍产出", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      '::::question{type=judge difficulty=9 knowledge="考点"}',
      "题一。[[正确]]",
      "::::",
      "",
      "::::question{type=judge difculty=3}",
      "题二。[[正确]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    const attrIssues = result.issues.filter(
      (i) => i.code === "INVALID_QUESTION_ATTRS",
    );
    expect(attrIssues).toHaveLength(2);
    const kept = result.units[0]?.questions ?? [];
    expect(kept).toHaveLength(2);
    expect(kept[0]?.difficulty).toBe(2); // difficulty=9 非法 → 回退缺省
    expect(kept[1]?.difficulty).toBe(2); // 未知属性名 difculty → 缺省
  });

  it("空填空标记 [[ ]]：记 INVALID_BLANK_MARKER，不计入答案", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill}",
      "补全：[[ ]]。",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(codes(result.issues)).toContain("INVALID_BLANK_MARKER");
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
  });

  it("行内代码与代码块内的 [[…]] 不识别为空", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill}",
      "示例 `[[99]]` 与：",
      "",
      "```",
      "[[98]]",
      "```",
      "真正的空是 [[1]]。",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "fill",
      blanks: [["1"]],
    });
  });

  it("solve 无 :::answer：answers 缺省（留给 linter/导入层处理）", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=solve difficulty=3}",
      "计算 $1+1$，写出过程。",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
  });

  it("判断题只接受 [[正确]]/[[错误]]，其余写法（如 [[对]]）不产生答案", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge}",
      "这个说法对。[[对]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
  });

  it("选择题无正确项：options 照常记录，answers 缺省（无/多正确项的报错归 T1.5 linter）", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=choice}",
      "选一个：",
      "",
      "- [ ] 甲",
      "- [ ] 乙",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.units[0]?.questions[0]?.options?.map((o) => o.text)).toEqual([
      "甲",
      "乙",
    ]);
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
  });

  it("单选出现多个 [x]：解析记录第一个正确项，不在解析期报错", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=choice}",
      "选一个：",
      "",
      "- [x] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "choice",
      index: 0,
    });
  });

  it("嵌套版式指令（如 :::warning）保留在题干内，不影响子指令提取", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=fill}",
      "计算：",
      "",
      ':::warning{title="易错点"}',
      "$-2^2 \\neq (-2)^2$。",
      ":::",
      "",
      "$(-3)+7=$ [[4]]。",
      "",
      ":::hint",
      "先定符号。",
      ":::",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    const question = result.units[0]?.questions[0];
    expect(question?.stemMd).toContain("易错点");
    expect(question?.stemMd).toContain("[[4]]");
    expect(question?.hints).toEqual(["先定符号。"]);
    expect(question?.answers).toEqual({ kind: "fill", blanks: [["4"]] });
  });

  it("未知子指令不崩溃：内容留在题干（近似名提示留给 T1.5 linter）", () => {
    const md = [
      "---",
      "kind: practice",
      "unit: 练习",
      "---",
      "",
      "::::question{type=judge}",
      "判断：$1+1=2$。[[正确]]",
      "::::",
      "",
    ].join("\n");
    const result = parseDocument(md);
    expect(result.issues).toEqual([]);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: true,
    });
  });
});

describe("parseDocument：fallbackUnitId 单元名锚定文件名（内容模型与导入规范化方案 §2）", () => {
  /** 未声明 unit 的练习文档（导入场景：单元名缺省从文件名派生） */
  const noUnit = [
    "---",
    "kind: practice",
    "---",
    "",
    "::::question{type=judge difficulty=1}",
    "$0$ 是正数。[[错误]]",
    "::::",
    "",
  ].join("\n");
  /** 声明了 unit 的练习文档（frontmatter 显式身份，fallback 不参与） */
  const withUnit = noUnit.replace(
    "kind: practice",
    "kind: practice\nunit: 练习四",
  );

  it("frontmatter.unit 存在：frontmatter 赢，fallbackUnitId 不生效、无 UNIT_FROM_FALLBACK", () => {
    const result = parseDocument(withUnit, { fallbackUnitId: "有理数练习" });
    expect(result.units[0]?.id).toBe("练习四");
    expect(result.units[0]?.title).toBe("练习四");
    expect(result.units[0]?.questions[0]?.id).toBe("练习四-1");
    expect(codes(result.issues)).not.toContain("UNIT_FROM_FALLBACK");
  });

  it("frontmatter.unit 缺失 + fallbackUnitId：单元 id/title 与缺省题目 id（文件名-序号）都用文件名", () => {
    const result = parseDocument(noUnit, { fallbackUnitId: "有理数练习" });
    expect(result.units[0]?.id).toBe("有理数练习");
    expect(result.units[0]?.title).toBe("有理数练习");
    expect(result.units[0]?.questions[0]?.id).toBe("有理数练习-1");
  });

  it("无 unit 无 fallback：兜底字面量，行为与现状一致", () => {
    const result = parseDocument(noUnit);
    expect(result.units[0]?.id).toBe("unit");
    expect(result.units[0]?.title).toBe("未命名单元");
    expect(result.units[0]?.questions[0]?.id).toBe("unit-1");
    expect(codes(result.issues)).not.toContain("UNIT_FROM_FALLBACK");
  });

  it("UNIT_FROM_FALLBACK：fallback 生效时记 warning（消息含文件名与声明建议），frontmatter.unit 存在时不出现", () => {
    const hit = parseDocument(noUnit, {
      fallbackUnitId: "有理数练习",
    }).issues.find((i) => i.code === "UNIT_FROM_FALLBACK");
    expect(hit?.level).toBe("warning");
    expect(hit?.message).toContain("有理数练习");
    expect(hit?.message).toContain("unit");
    const miss = parseDocument(withUnit, { fallbackUnitId: "有理数练习" });
    expect(codes(miss.issues)).not.toContain("UNIT_FROM_FALLBACK");
  });

  it("options.unitId（reparse 语义）与 fallbackUnitId 同传：options.unitId 覆盖一切、无 UNIT_FROM_FALLBACK", () => {
    const result = parseDocument(noUnit, {
      unitId: "原单元",
      fallbackUnitId: "有理数练习",
    });
    expect(result.units[0]?.id).toBe("原单元");
    expect(result.units[0]?.title).toBe("原单元");
    expect(result.units[0]?.questions[0]?.id).toBe("原单元-1");
    expect(codes(result.issues)).not.toContain("UNIT_FROM_FALLBACK");
  });
});
