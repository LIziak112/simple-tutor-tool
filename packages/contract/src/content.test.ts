import { describe, expect, it } from "vitest";
import {
  documentKindSchema,
  frontmatterSchema,
  lectureSchema,
  lintIssueSchema,
  parsedDocumentSchema,
  questionAnswersSchema,
  questionPublicSchema,
  questionSchema,
  questionTypeSchema,
  unitSchema,
} from "./content";

/** 一道完整的选择题（含教师侧机密字段：answers/hints/solutionMd/sourceMd），供多组用例复用 */
const fullChoiceQuestion = {
  id: "lianxi4-2",
  type: "choice",
  difficulty: 1,
  knowledge: ["相反数"],
  stemMd: "$-5$ 的相反数是（ ）",
  options: [
    { text: "$-5$", correct: false },
    { text: "$5$", correct: true },
    { text: "$\\frac{1}{5}$", correct: false },
  ],
  answers: { kind: "choice", index: 1 },
  hints: ["只有符号不同的两个数互为相反数"],
  solutionMd: "只有符号不同的两个数互为相反数，故 $-5$ 的相反数是 $5$。",
  sourceMd:
    '::::question{type=choice difficulty=1 knowledge="相反数"}\n$-5$ 的相反数是（ ）\n\n- [ ] $-5$\n- [x] $5$\n- [ ] $\\frac{1}{5}$\n::::',
};

describe("QuestionType：七种题型（§5.1）", () => {
  it("恰为七种题型，逐一可解析", () => {
    expect(questionTypeSchema.options).toEqual([
      "judge",
      "choice",
      "multi",
      "fill",
      "solve",
      "apply",
      "find-error",
    ]);
    for (const type of questionTypeSchema.options) {
      expect(questionTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("未知题型被拒绝（lint 由 T1.5 报错，契约层不允许入库）", () => {
    expect(questionTypeSchema.safeParse("essay").success).toBe(false);
    expect(questionTypeSchema.safeParse("single-choice").success).toBe(false);
  });
});

describe("Question：题目（教师侧完整形态）", () => {
  it("完整选择题解析成功，字段原样保留", () => {
    const parsed = questionSchema.parse(fullChoiceQuestion);
    expect(parsed).toEqual(fullChoiceQuestion);
  });

  it("填空题：answers.blanks 为多空数组，每空是等价答案列表", () => {
    const parsed = questionSchema.parse({
      id: "lianxi4-1",
      type: "fill",
      difficulty: 2,
      stemMd: "计算：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。",
      answers: {
        kind: "fill",
        blanks: [["4"], ["-7"]],
      },
      sourceMd: "::::question{type=fill difficulty=2}\n…\n::::",
    });
    expect(parsed.answers).toEqual({ kind: "fill", blanks: [["4"], ["-7"]] });
  });

  it("填空等价答案：一空多个可接受写法", () => {
    expect(
      questionAnswersSchema.safeParse({
        kind: "fill",
        blanks: [["0.5", "1/2"], ["2"]],
      }).success,
    ).toBe(true);
  });

  it("多选题：answers 为正确项下标数组", () => {
    expect(
      questionAnswersSchema.safeParse({ kind: "multi", indexes: [0, 2] })
        .success,
    ).toBe(true);
  });

  it("判断题：answers 为布尔值", () => {
    expect(
      questionAnswersSchema.safeParse({ kind: "judge", value: true }).success,
    ).toBe(true);
    expect(
      questionAnswersSchema.safeParse({ kind: "judge", value: "正确" }).success,
    ).toBe(false);
  });

  it("手写题（solve/apply/find-error）：可选最终答案，缺省无 answers", () => {
    const withFinal = questionSchema.safeParse({
      id: "p4-q7",
      type: "solve",
      difficulty: 3,
      stemMd: "计算 $-2^2+(-3)\\times(-\\frac{1}{3})$，写出过程。",
      answers: { kind: "final", answer: "-3" },
      sourceMd: "::::question{type=solve difficulty=3}\n…\n::::",
    });
    expect(withFinal.success).toBe(true);
    const withoutFinal = questionSchema.safeParse({
      id: "p4-q8",
      type: "apply",
      difficulty: 3,
      stemMd: "某地气温上午为 3℃，下午下降 5℃，求下午气温。",
      sourceMd: "::::question{type=apply}\n…\n::::",
    });
    expect(withoutFinal.success).toBe(true);
  });

  it("answers 判别字段 kind 非法时整体拒绝", () => {
    expect(
      questionAnswersSchema.safeParse({ kind: "essay", text: "任意" }).success,
    ).toBe(false);
  });

  it("knowledge 与 hints 缺省为空数组", () => {
    const parsed = questionSchema.parse({
      id: "lianxi4-3",
      type: "judge",
      difficulty: 1,
      stemMd: "$0$ 既不是正数也不是负数。 [[正确]]",
      answers: { kind: "judge", value: true },
      sourceMd: "::::question{type=judge difficulty=1}\n…\n::::",
    });
    expect(parsed.knowledge).toEqual([]);
    expect(parsed.hints).toEqual([]);
  });

  it("difficulty 为 1–5 的整数，越界或非整数拒绝", () => {
    const base = {
      id: "d",
      type: "judge",
      stemMd: "stem",
      sourceMd: "src",
      answers: { kind: "judge", value: true },
    } as const;
    for (const bad of [0, 6, 2.5, "3"]) {
      expect(
        questionSchema.safeParse({ ...base, difficulty: bad }).success,
      ).toBe(false);
    }
    expect(questionSchema.safeParse({ ...base, difficulty: 5 }).success).toBe(
      true,
    );
  });

  it("id 与 sourceMd 必填", () => {
    const minimal = {
      type: "judge",
      difficulty: 1,
      stemMd: "stem",
      answers: { kind: "judge", value: false },
    };
    expect(questionSchema.safeParse(minimal).success).toBe(false);
    expect(questionSchema.safeParse({ ...minimal, id: "x" }).success).toBe(
      false,
    );
  });
});

describe("QuestionPublic：学生端公开形态（防泄露核心）", () => {
  it("解析含 answers/solutionMd/hints/sourceMd 的对象时剥离这些字段（strip）", () => {
    // 输入模拟服务端投影：options 已映射为纯文本，但教师侧机密字段残留在对象上
    const parsed = questionPublicSchema.parse({
      id: "lianxi4-2",
      type: "choice",
      difficulty: 1,
      knowledge: ["相反数"],
      stemMd: "$-5$ 的相反数是（ ）",
      options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
      hintCount: 1,
      answers: fullChoiceQuestion.answers,
      hints: fullChoiceQuestion.hints,
      solutionMd: fullChoiceQuestion.solutionMd,
      sourceMd: fullChoiceQuestion.sourceMd,
    });
    // 教师侧机密字段一律剥离
    expect(parsed).not.toHaveProperty("answers");
    expect(parsed).not.toHaveProperty("solutionMd");
    expect(parsed).not.toHaveProperty("hints");
    expect(parsed).not.toHaveProperty("sourceMd");
    expect(parsed).toEqual({
      id: "lianxi4-2",
      type: "choice",
      difficulty: 1,
      knowledge: ["相反数"],
      stemMd: "$-5$ 的相反数是（ ）",
      options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
      hintCount: 1,
    });
  });

  it("options 只接受纯文本数组：携带 correct 标记的选项对象被整体拒绝（fail closed）", () => {
    const result = questionPublicSchema.safeParse({
      id: "lianxi4-2",
      type: "choice",
      difficulty: 1,
      stemMd: "$-5$ 的相反数是（ ）",
      options: fullChoiceQuestion.options,
      hintCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("hintCount 必填且为非负整数", () => {
    const base = {
      id: "q",
      type: "fill",
      difficulty: 2,
      knowledge: [],
      stemMd: "计算：$(-3)+7=$ [[ ]]",
    };
    expect(questionPublicSchema.safeParse(base).success).toBe(false);
    expect(
      questionPublicSchema.safeParse({ ...base, hintCount: -1 }).success,
    ).toBe(false);
    expect(
      questionPublicSchema.safeParse({ ...base, hintCount: 1.5 }).success,
    ).toBe(false);
    expect(
      questionPublicSchema.safeParse({ ...base, hintCount: 3 }).success,
    ).toBe(true);
  });
});

describe("LintIssue：linter 输出（§5.1）", () => {
  it("合法 error/warning 均可解析，fix 可选", () => {
    expect(
      lintIssueSchema.safeParse({
        level: "error",
        line: 12,
        column: 1,
        code: "UNKNOWN_TYPE",
        message: "未知题型 essay",
        fix: "type=judge",
      }).success,
    ).toBe(true);
    expect(
      lintIssueSchema.safeParse({
        level: "warning",
        line: 3,
        column: 5,
        code: "UNREGISTERED_DIRECTIVE",
        message: "未注册指令 :::tabs，你是不是想用 :::fold？",
      }).success,
    ).toBe(true);
  });

  it("level 只允许 error/warning", () => {
    expect(
      lintIssueSchema.safeParse({
        level: "info",
        line: 1,
        column: 1,
        code: "X",
        message: "m",
      }).success,
    ).toBe(false);
  });

  it("line/column 为正整数，code/message 必填非空", () => {
    const valid = {
      level: "error",
      line: 2,
      column: 3,
      code: "C",
      message: "m",
    };
    for (const bad of [
      { ...valid, line: 0 },
      { ...valid, column: 0 },
      { ...valid, line: 1.5 },
      { ...valid, code: "" },
      { ...valid, message: "" },
    ]) {
      expect(lintIssueSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("Unit：练习单元", () => {
  it("单元含标题与题目列表", () => {
    const unit = unitSchema.parse({
      id: "lianxi4",
      title: "练习四",
      topic: "有理数加减混合",
      lectureTitle: "第4讲",
      questions: [fullChoiceQuestion],
    });
    expect(unit.questions).toHaveLength(1);
    expect(unit.title).toBe("练习四");
  });

  it("缺 title 或 questions 时拒绝", () => {
    expect(unitSchema.safeParse({ id: "lianxi4", questions: [] }).success).toBe(
      false,
    );
    expect(
      unitSchema.safeParse({ id: "lianxi4", title: "练习四" }).success,
    ).toBe(false);
  });
});

describe("Lecture：讲义", () => {
  it("含标题、原文 markdown 与 H2/H3 目录", () => {
    const lecture = lectureSchema.parse({
      title: "第4讲 有理数的加减",
      markdown: "# 第4讲 有理数的加减\n\n## 加法法则\n…\n### 例题\n…",
      headings: [
        { level: 2, text: "加法法则" },
        { level: 3, text: "例题" },
      ],
    });
    expect(lecture.headings.map((h) => h.text)).toEqual(["加法法则", "例题"]);
  });

  it("目录层级只允许 2/3（H1 是切分讲义的标题，H4 不进目录）", () => {
    const valid = {
      title: "第4讲",
      markdown: "# 第4讲",
      headings: [],
    };
    expect(
      lectureSchema.safeParse({
        ...valid,
        headings: [{ level: 1, text: "第4讲" }],
      }).success,
    ).toBe(false);
    expect(
      lectureSchema.safeParse({
        ...valid,
        headings: [{ level: 4, text: "小节" }],
      }).success,
    ).toBe(false);
    expect(
      lectureSchema.safeParse({
        ...valid,
        headings: [{ level: "2", text: "加法法则" }],
      }).success,
    ).toBe(false);
  });
});

describe("frontmatter 与文档类型", () => {
  it("kind 只允许 practice/lecture/mixed", () => {
    expect(documentKindSchema.options).toEqual([
      "practice",
      "lecture",
      "mixed",
    ]);
    expect(documentKindSchema.safeParse("homework").success).toBe(false);
  });

  it("dsl 版本缺省为 2", () => {
    const parsed = frontmatterSchema.parse({
      kind: "practice",
      unit: "练习四",
      topic: "有理数加减混合",
    });
    expect(parsed.dsl).toBe(2);
  });
});

describe("ParsedDocument：解析结果（T1.3/T1.4/T1.6 产出）", () => {
  it("完整练习文档解析成功", () => {
    const doc = parsedDocumentSchema.parse({
      frontmatter: {
        kind: "practice",
        dsl: 2,
        unit: "练习四",
        lecture: "第4讲",
        topic: "有理数加减混合",
      },
      lectures: [],
      units: [
        {
          id: "lianxi4",
          title: "练习四",
          topic: "有理数加减混合",
          lectureTitle: "第4讲",
          questions: [fullChoiceQuestion],
        },
      ],
      issues: [],
    });
    expect(doc.units[0]?.questions).toHaveLength(1);
  });

  it("frontmatter 缺失（解析失败场景）仍可表达，units/lectures/issues 缺省为空数组", () => {
    const doc = parsedDocumentSchema.parse({
      issues: [
        {
          level: "error",
          line: 1,
          column: 1,
          code: "MISSING_FRONTMATTER",
          message: "缺少 frontmatter",
        },
      ],
    });
    expect(doc.frontmatter).toBeUndefined();
    expect(doc.units).toEqual([]);
    expect(doc.lectures).toEqual([]);
  });

  it("frontmatter.kind 非法时拒绝", () => {
    expect(
      parsedDocumentSchema.safeParse({
        frontmatter: { kind: "workbook" },
        units: [],
        lectures: [],
        issues: [],
      }).success,
    ).toBe(false);
  });
});
