import { describe, expect, it } from "vitest";
import { questionEvidenceBindings } from "./capability.ts";
import {
  formatQuestionAnswers,
  QUESTION_TYPE_LABELS,
  questionAnswersSchema,
  questionPublicSchema,
  questionSchema,
  questionTypeSchema,
} from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";

/**
 * 新题型答案与参考契约测试（TT-05a 域②，QM-01 §5.3/§5.7 定稿）：
 * response/matching/ordering 的学生答案与参考答案形态、可缺省策略、
 * formatQuestionAnswers 三分支、题型枚举扩容（D2）、公开投影白名单扩展、
 * 旧快照键集不变与旧客户端写入保护（§5.8.3）。
 */

describe("questionTypeSchema 扩容（D2：三底层交互枚举追加在尾，旧七型序不变）", () => {
  it("枚举 = 旧七型 + response/matching/ordering", () => {
    expect(questionTypeSchema.options).toEqual([
      "judge",
      "choice",
      "multi",
      "fill",
      "solve",
      "apply",
      "find-error",
      "response",
      "matching",
      "ordering",
    ]);
  });

  it("新题型中文标签（QUESTION_TYPE_LABELS 穷尽 Record）", () => {
    expect(QUESTION_TYPE_LABELS.response).toBe("开放");
    expect(QUESTION_TYPE_LABELS.matching).toBe("配对");
    expect(QUESTION_TYPE_LABELS.ordering).toBe("排序");
  });

  it("新题型的答案 kind 由跨端证据角色绑定声明（D14 表）", () => {
    expect(questionEvidenceBindings.response).toEqual({
      answerKind: "response",
      paperRole: "answerInk",
    });
    expect(questionEvidenceBindings.matching).toEqual({
      answerKind: "matching",
      paperRole: "scratch",
    });
    expect(questionEvidenceBindings.ordering).toEqual({
      answerKind: "ordering",
      paperRole: "scratch",
    });
  });
});

describe("response 学生答案（§5.3.1：body 空串=未写正文，不校验字数）", () => {
  it("完整形态：title 可选、body 必填（空串合法）", () => {
    expect(
      studentAnswerSchema.parse({ kind: "response", body: "正文" }),
    ).toEqual({ kind: "response", body: "正文" });
    expect(
      studentAnswerSchema.parse({
        kind: "response",
        title: "标题",
        body: "正文",
      }),
    ).toEqual({ kind: "response", title: "标题", body: "正文" });
    expect(studentAnswerSchema.parse({ kind: "response", body: "" })).toEqual({
      kind: "response",
      body: "",
    });
  });

  it("缺 body 拒绝（旧客户端/构造请求的形态防线，§5.8.3）", () => {
    expect(studentAnswerSchema.safeParse({ kind: "response" }).success).toBe(
      false,
    );
  });

  it("未知键被 strip（结构校验无未知键的 schema 面）", () => {
    expect(
      studentAnswerSchema.parse({
        kind: "response",
        body: "x",
        answer: "伪造",
      }),
    ).toEqual({ kind: "response", body: "x" });
  });
});

describe("matching 学生答案（§5.3.1：部分配对=草稿合法；结构校验不接触参考）", () => {
  it("pairs 为 slotId→optionId 记录；空对象与部分配对均合法（草稿）", () => {
    expect(studentAnswerSchema.parse({ kind: "matching", pairs: {} })).toEqual({
      kind: "matching",
      pairs: {},
    });
    expect(
      studentAnswerSchema.parse({
        kind: "matching",
        pairs: { "slot-1": "opt-2" },
      }),
    ).toEqual({ kind: "matching", pairs: { "slot-1": "opt-2" } });
  });

  it("pairs 非记录形态拒绝（键值须为非空字符串）", () => {
    expect(
      studentAnswerSchema.safeParse({ kind: "matching", pairs: ["opt-1"] })
        .success,
    ).toBe(false);
    expect(
      studentAnswerSchema.safeParse({
        kind: "matching",
        pairs: { "slot-1": "" },
      }).success,
    ).toBe(false);
  });
});

describe("ordering 学生答案（§5.3.1：部分序列=草稿合法；重复/干扰项由 inspectShape 报告不拦截）", () => {
  it("sequence 为 itemId 数组；空数组与部分序列均合法（草稿）", () => {
    expect(
      studentAnswerSchema.parse({ kind: "ordering", sequence: [] }),
    ).toEqual({ kind: "ordering", sequence: [] });
    expect(
      studentAnswerSchema.parse({ kind: "ordering", sequence: ["item-1"] }),
    ).toEqual({ kind: "ordering", sequence: ["item-1"] });
  });

  it("非字符串元素拒绝", () => {
    expect(
      studentAnswerSchema.safeParse({ kind: "ordering", sequence: [1] })
        .success,
    ).toBe(false);
  });
});

describe("参考答案三分支（§5.3.2：主观参考 Markdown 可缺省=整个 answers 可缺省）", () => {
  it("response 参考：referenceMd 必填非空、variantsMd 可选有序数组", () => {
    expect(
      questionAnswersSchema.parse({
        kind: "response",
        referenceMd: "**证明**：由已知得……",
        variantsMd: ["第一种译法……", "第二种译法……"],
      }),
    ).toEqual({
      kind: "response",
      referenceMd: "**证明**：由已知得……",
      variantsMd: ["第一种译法……", "第二种译法……"],
    });
    expect(
      questionAnswersSchema.parse({
        kind: "response",
        referenceMd: "参考",
      }),
    ).toEqual({ kind: "response", referenceMd: "参考" });
    expect(
      questionAnswersSchema.safeParse({ kind: "response", referenceMd: "" })
        .success,
    ).toBe(false);
  });

  it("matching 参考：纯 ID 映射（提供时可发布校验要求全覆盖——TT-06 发布层）", () => {
    expect(
      questionAnswersSchema.parse({
        kind: "matching",
        pairs: { "slot-1": "opt-1", "slot-2": "opt-3" },
      }),
    ).toEqual({
      kind: "matching",
      pairs: { "slot-1": "opt-1", "slot-2": "opt-3" },
    });
  });

  it("ordering 参考：完整序列（固定项也列出；可发布校验=非干扰项恰一次、固定项在位）", () => {
    expect(
      questionAnswersSchema.parse({
        kind: "ordering",
        sequence: ["item-2", "item-4", "item-5"],
      }),
    ).toEqual({
      kind: "ordering",
      sequence: ["item-2", "item-4", "item-5"],
    });
    expect(
      questionAnswersSchema.safeParse({ kind: "ordering", sequence: [] })
        .success,
    ).toBe(false);
  });
});

describe("formatQuestionAnswers 三分支（参考文本唯一入口）", () => {
  it("response → referenceMd 原文（已是 Markdown，不做 mathify 包裹）", () => {
    expect(
      formatQuestionAnswers({ kind: "response", referenceMd: "$a_n = 2^n-1$" }),
    ).toBe("$a_n = 2^n-1$");
  });

  it("matching → 键序稳定的「slot = opt」行式（与 DSL :::answer 书写形态对称），「；」连接", () => {
    expect(
      formatQuestionAnswers({
        kind: "matching",
        pairs: { "slot-2": "opt-5", "slot-1": "opt-1" },
      }),
    ).toBe("slot-1 = opt-1；slot-2 = opt-5");
  });

  it("ordering → 依序「 → 」连接（行序即正确顺序）", () => {
    expect(
      formatQuestionAnswers({
        kind: "ordering",
        sequence: ["item-2", "item-4", "item-1"],
      }),
    ).toBe("item-2 → item-4 → item-1");
  });
});

describe("questionSchema 新可选字段（§5.4.1/§5.8.1：全量可选，不侵入旧文档）", () => {
  const base = {
    id: "q-1",
    type: "matching" as const,
    difficulty: 3,
    stemMd: "题干",
    sourceMd: "::::question{...}",
  };

  it("matching 题可携带选项池抽取副本（allowRepeat 缺省 false；干扰项标记公开）", () => {
    const parsed = questionSchema.parse({
      ...base,
      matchingOptions: {
        options: [
          { id: "opt-1", text: "选项一" },
          { id: "opt-9", text: "干扰", distractor: true },
        ],
      },
    });
    expect(parsed.matchingOptions).toEqual({
      allowRepeat: false,
      options: [
        { id: "opt-1", text: "选项一", distractor: false },
        { id: "opt-9", text: "干扰", distractor: true },
      ],
    });
    expect(
      questionSchema.safeParse({ ...base, matchingOptions: { options: [] } })
        .success,
    ).toBe(false);
  });

  it("ordering 题可携带项抽取副本（fixedPosition 来自参考序列声明位，缺省 null）", () => {
    const parsed = questionSchema.parse({
      ...base,
      type: "ordering",
      orderingItems: [
        { id: "it-1", text: "甲" },
        { id: "it-2", text: "乙", fixedPosition: 1 },
        { id: "it-6", text: "干扰", distractor: true },
      ],
    });
    expect(parsed.orderingItems?.[0]).toEqual({
      id: "it-1",
      text: "甲",
      fixedPosition: null,
      distractor: false,
    });
    expect(parsed.orderingItems?.[1]?.fixedPosition).toBe(1);
  });

  it("response 题可携带字数提示（word-min/word-max 仅提示，正整数）", () => {
    const parsed = questionSchema.parse({
      ...base,
      type: "response",
      wordMin: 150,
      wordMax: 250,
    });
    expect(parsed.wordMin).toBe(150);
    expect(parsed.wordMax).toBe(250);
    expect(
      questionSchema.safeParse({ ...base, type: "response", wordMin: 0 })
        .success,
    ).toBe(false);
  });

  it("旧快照可解析：旧七型题目键集不变（新字段缺省不注入键，§5.8.3）", () => {
    const oldQuestion = {
      id: "u1-1",
      type: "choice",
      difficulty: 2,
      knowledge: ["考点"],
      stemMd: "题干",
      options: [{ text: "A" }],
      answers: { kind: "choice", index: 1 },
      hints: [],
      sourceMd: "原文",
    };
    const parsed = questionSchema.parse(oldQuestion);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "answers",
        "difficulty",
        "hints",
        "id",
        "knowledge",
        "options",
        "sourceMd",
        "stemMd",
        "type",
      ].sort(),
    );
  });
});

describe("questionPublicSchema 白名单扩展（作答面结构随题下发，fail closed）", () => {
  const base = {
    id: "q-1",
    type: "matching" as const,
    difficulty: 3,
    knowledge: ["配对"],
    stemMd: "题干",
    hintCount: 0,
  };

  it("携带选项池/项/字数提示（学生作答必需的公开结构）", () => {
    const parsed = questionPublicSchema.parse({
      ...base,
      matchingOptions: {
        options: [
          { id: "opt-1", text: "一" },
          { id: "opt-2", text: "二" },
        ],
      },
      wordMin: 10,
    });
    expect(parsed.matchingOptions?.options).toHaveLength(2);
    expect(parsed.wordMin).toBe(10);
  });

  it("matching 槽位集合（服务端按材料槽位序展开的有序 slotId）随题下发；缺省不注入键", () => {
    // QM-13 细项 2：matching 作答行 = 声明槽位集合；slots= 区间的展开在
    // 服务端投影时完成，学生端只消费有序 id 列表（不重复解析 DSL 选择串）
    const parsed = questionPublicSchema.parse({
      ...base,
      matchingSlots: ["slot-1", "slot-2", "slot-3"],
    });
    expect(parsed.matchingSlots).toEqual(["slot-1", "slot-2", "slot-3"]);
    // 空 id / 空数组拒绝（防御性边界：展开产物必非空）
    expect(
      questionPublicSchema.safeParse({
        ...base,
        matchingSlots: ["slot-1", ""],
      }).success,
    ).toBe(false);
    expect(
      questionPublicSchema.safeParse({ ...base, matchingSlots: [] }).success,
    ).toBe(false);
    const bare = questionPublicSchema.parse(base);
    expect(bare).not.toHaveProperty("matchingSlots");
  });

  it("教师侧键（answers/solutionMd/sourceMd/hints 内容）仍被剥离", () => {
    const parsed = questionPublicSchema.parse({
      ...base,
      answers: { kind: "matching", pairs: { "slot-1": "opt-1" } },
      solutionMd: "详解",
      sourceMd: "原文",
      hints: ["提示内容"],
    });
    expect(parsed).not.toHaveProperty("answers");
    expect(parsed).not.toHaveProperty("solutionMd");
    expect(parsed).not.toHaveProperty("sourceMd");
    expect(parsed).not.toHaveProperty("hints");
    expect(parsed.hintCount).toBe(0);
  });

  it("审查 P1 收紧：学生面变体剥离 distractor 键（教师侧全量另见 matchingOptionsSchema/orderingItemSchema），sortableCount 计数随 ordering 下发", () => {
    const parsed = questionPublicSchema.parse({
      ...base,
      matchingOptions: {
        allowRepeat: false,
        options: [
          { id: "opt-1", text: "一", distractor: true },
          { id: "opt-2", text: "二", distractor: false },
        ],
      },
      orderingItems: [
        { id: "it-1", text: "甲", fixedPosition: null, distractor: false },
        { id: "it-2", text: "乙", fixedPosition: 1, distractor: false },
        { id: "it-6", text: "己", fixedPosition: null, distractor: true },
      ],
      sortableCount: 1,
    });
    // 混入的 distractor 标记被 strip（fail closed：多给的键不透传）
    for (const option of parsed.matchingOptions?.options ?? []) {
      expect("distractor" in option).toBe(false);
    }
    for (const item of parsed.orderingItems ?? []) {
      expect("distractor" in item).toBe(false);
    }
    // fixedPosition 属公开结构（§6.1 调整 3），学生面保留
    expect(parsed.orderingItems?.[1]?.fixedPosition).toBe(1);
    expect(parsed.sortableCount).toBe(1);
    // sortableCount 缺省不注入键（非 ordering 题不携带）
    const bare = questionPublicSchema.parse(base);
    expect(bare).not.toHaveProperty("sortableCount");
  });
});
