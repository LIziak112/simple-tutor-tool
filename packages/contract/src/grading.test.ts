import { describe, expect, it } from "vitest";
import {
  choiceStudentAnswerSchema,
  fillStudentAnswerSchema,
  finalTextDeliveryScoringSourceSchema,
  handwrittenStudentAnswerSchema,
  judgeStudentAnswerSchema,
  matchingDeliveryAnswerSchema,
  matchingDeliveryScoringSourceSchema,
  matchingDeliveryValueOf,
  multiStudentAnswerSchema,
  orderedTextDeliveryScoringSourceSchema,
  questionDeliveryScoringSourcesSchema,
  RESPONSE_BODY_MAX_CHARS,
  RESPONSE_TITLE_MAX_CHARS,
  responseDeliveryScoringSourceSchema,
  responseStudentAnswerSchema,
  singleChoiceScoringSourceSchema,
  studentAnswerSchema,
  wholeQuestionDeliveryScoringSourcesSchema,
} from "./grading";

describe("StudentAnswer：各题型学生答案（T2.5）", () => {
  it("判断题：布尔为标准形态，字符串写法（旧版 §5 全集）同样可解析", () => {
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: true })
        .success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: false })
        .success,
    ).toBe(true);
    // 旧版判断题写法：对/错/√/×/T/F/TRUE/FALSE/是/否 等，判分时归一化
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "对" })
        .success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "×" }).success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "" }).success,
    ).toBe(true);
  });

  it("判断题：value 缺省或数字等其他类型被拒绝", () => {
    expect(judgeStudentAnswerSchema.safeParse({ kind: "judge" }).success).toBe(
      false,
    );
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: 1 }).success,
    ).toBe(false);
  });

  it("单选：index 为 0 起非负整数（与 choiceAnswersSchema.index 同口径）", () => {
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 0 }).success,
    ).toBe(true);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 3 }).success,
    ).toBe(true);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: -1 })
        .success,
    ).toBe(false);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 1.5 })
        .success,
    ).toBe(false);
  });

  it("多选：indexes 为下标集合，允许空数组（未选）", () => {
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [0, 2] })
        .success,
    ).toBe(true);
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [] })
        .success,
    ).toBe(true);
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [-1] })
        .success,
    ).toBe(false);
  });

  it("填空：values 按空序，元素允许空串（空着交卷）", () => {
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: ["4", "-7"] })
        .success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [""] }).success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [] }).success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [3] }).success,
    ).toBe(false);
  });

  it("手写题最终答案：finalAnswer 允许空串（未填 → 判 null 进待批）", () => {
    expect(
      handwrittenStudentAnswerSchema.safeParse({
        kind: "final",
        finalAnswer: "-3",
      }).success,
    ).toBe(true);
    expect(
      handwrittenStudentAnswerSchema.safeParse({
        kind: "final",
        finalAnswer: "",
      }).success,
    ).toBe(true);
    expect(
      handwrittenStudentAnswerSchema.safeParse({ kind: "final" }).success,
    ).toBe(false);
  });

  it("response：title 可缺省、body 允许空串（仅手写作答合法）；标题/正文各有防御性字符上限（拒绝不截断，QM-09）", () => {
    expect(
      responseStudentAnswerSchema.safeParse({ kind: "response", body: "" })
        .success,
    ).toBe(true);
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        title: "分歧是治理的起点",
        body: "第一段……\n\n第二段……",
      }).success,
    ).toBe(true);
    // 上限内长文不截断可保存（5 万字符量级，远超任何作文题）
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        body: "字".repeat(RESPONSE_BODY_MAX_CHARS),
      }).success,
    ).toBe(true);
    // 超限拒绝（保存与提交同码走 VALIDATION_ERROR，不在任何一层截断长文）
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        body: "字".repeat(RESPONSE_BODY_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        title: "题".repeat(RESPONSE_TITLE_MAX_CHARS + 1),
        body: "正文",
      }).success,
    ).toBe(false);
    expect(
      responseStudentAnswerSchema.safeParse({ kind: "response" }).success,
    ).toBe(false);
  });

  it("判别联合：五种 kind 可解析，未知 kind 被拒绝", () => {
    expect(
      studentAnswerSchema.safeParse({ kind: "judge", value: true }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "choice", index: 1 }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "multi", indexes: [0] }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "fill", values: ["1/2"] }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "final", finalAnswer: "1.4" })
        .success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "essay", text: "…" }).success,
    ).toBe(false);
  });
});

describe("单选评分来源", () => {
  const source = {
    type: "choice",
    options: [{ text: "甲" }, { text: "乙" }],
    answers: { kind: "choice", index: 1 },
  };

  it("接受实际存在的正确选项", () => {
    expect(singleChoiceScoringSourceSchema.parse(source)).toEqual(source);
  });

  it.each([
    ["题型不符", { type: "judge" }],
    ["标准答案 kind 不符", { answers: { kind: "multi", indexes: [1] } }],
    ["缺标准答案", { answers: undefined }],
    ["缺选项", { options: undefined }],
    ["正确项越界", { answers: { kind: "choice", index: 2 } }],
  ])("拒绝%s", (_case, changes) => {
    expect(
      singleChoiceScoringSourceSchema.safeParse({ ...source, ...changes })
        .success,
    ).toBe(false);
  });
});

describe("整卷手写最终文本的评分来源", () => {
  it.each(["solve", "apply", "find-error"])(
    "整卷的 %s 使用单槽，讲练范围不变",
    (type) => {
      const source = { type, answers: { kind: "final", answer: "原参考" } };
      expect(wholeQuestionDeliveryScoringSourcesSchema.parse([source])).toEqual(
        [{ acceptedBlanks: [["原参考"]] }],
      );
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.parse([{ type }]),
      ).toEqual([{ acceptedBlanks: [[]] }]);
      expect(
        questionDeliveryScoringSourcesSchema.safeParse([source]).success,
      ).toBe(false);
    },
  );

  it("最终文本形态拒绝答问，含无参考答案的答问", () => {
    expect(
      finalTextDeliveryScoringSourceSchema.safeParse({ type: "response" })
        .success,
    ).toBe(false);
  });
});

describe("整卷答问的评分来源", () => {
  const source = {
    type: "response",
    answers: { kind: "response", referenceMd: "答问范文" },
  };

  it("整卷接收独立答问来源，有无范文都合法，讲练范围不变", () => {
    const withoutReference = { type: "response" };
    expect(responseDeliveryScoringSourceSchema.parse(source)).toEqual(source);
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.parse([
        source,
        withoutReference,
      ]),
    ).toEqual([source, withoutReference]);
    expect(
      questionDeliveryScoringSourcesSchema.safeParse([source]).success,
    ).toBe(false);
  });

  it("答问参考与手写最终文本各用自己的形态", () => {
    const finalSource = {
      type: "solve",
      answers: { kind: "final", answer: "最终文本参考" },
    };
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.parse([source, finalSource]),
    ).toEqual([source, { acceptedBlanks: [["最终文本参考"]] }]);
    expect(
      orderedTextDeliveryScoringSourceSchema.safeParse(source).success,
    ).toBe(false);
    expect(
      responseDeliveryScoringSourceSchema.safeParse(finalSource).success,
    ).toBe(false);
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([
        { ...source, answers: finalSource.answers },
      ]).success,
    ).toBe(false);
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([
        { ...finalSource, answers: source.answers },
      ]).success,
    ).toBe(false);
  });

  it("拒绝把学生正文或空范文当成评分来源", () => {
    for (const answers of [
      { kind: "response", body: "学生正文" },
      { kind: "response", referenceMd: "" },
    ]) {
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.safeParse([
          { ...source, answers },
        ]).success,
      ).toBe(false);
    }
  });
});

describe("整卷排序的冻结来源", () => {
  const source = {
    type: "ordering",
    orderingItems: [
      { id: "option-a", text: "甲", fixedPosition: null, distractor: false },
      { id: "option-b", text: "乙", fixedPosition: 1, distractor: false },
      { id: "decoy", text: "干扰项", fixedPosition: null, distractor: true },
    ],
    answers: { kind: "ordering", sequence: ["option-b", "option-a"] },
  };

  it("整卷保留实际冻结项和参考顺序，排序在讲练交付与填空形态之外", () => {
    expect(wholeQuestionDeliveryScoringSourcesSchema.parse([source])).toEqual([
      { ...source, acceptedBlanks: [["option-b"], ["option-a"]] },
    ]);
    expect(
      questionDeliveryScoringSourcesSchema.safeParse([source]).success,
    ).toBe(false);
    expect(
      orderedTextDeliveryScoringSourceSchema.safeParse(source).success,
    ).toBe(false);
  });

  it("须以完整冻结项和真实顺序声明排序参考", () => {
    for (const sequence of [
      [],
      ["option-b"],
      ["option-a", "option-b"],
      ["option-b", "decoy"],
      ["option-b", "unknown"],
    ]) {
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.safeParse([
          { ...source, answers: { kind: "ordering", sequence } },
        ]).success,
      ).toBe(false);
    }
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([
        { ...source, answers: undefined },
      ]).success,
    ).toBe(false);
  });

  it("无参考的零槽排序只进入整卷待批分区", () => {
    const unkeyed = {
      type: source.type,
      orderingItems: source.orderingItems.map((item) => ({
        ...item,
        fixedPosition: null,
        distractor: true,
      })),
    };
    expect(wholeQuestionDeliveryScoringSourcesSchema.parse([unkeyed])).toEqual([
      unkeyed,
    ]);
    expect(
      questionDeliveryScoringSourcesSchema.safeParse([unkeyed]).success,
    ).toBe(false);
    for (const invalid of [
      { ...unkeyed, answers: null },
      { ...unkeyed, answers: { kind: "ordering", sequence: [] } },
      { ...unkeyed, answers: source.answers },
      { ...unkeyed, orderingItems: [] },
    ]) {
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.safeParse([invalid]).success,
      ).toBe(false);
    }
  });

  it("不接受缺少冻结项的排序或把其他作答形态当成参考", () => {
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([
        { ...source, orderingItems: undefined },
      ]).success,
    ).toBe(false);
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([
        { ...source, answers: { kind: "response", referenceMd: "参考" } },
      ]).success,
    ).toBe(false);
  });
});

describe("整卷配对的冻结来源与原值", () => {
  const source = {
    type: "matching",
    matchingOptions: {
      allowRepeat: true,
      options: [
        { id: "opt,共同", text: "共同项", distractor: false },
        { id: "opt=干扰", text: "可选干扰项", distractor: true },
      ],
    },
    answers: {
      kind: "matching",
      pairs: { "slot=乙": "opt,共同", "slot,甲": "opt,共同" },
    },
  };

  it("整卷逐位保留冻结参考的原始槽位和选项，讲练范围不变", () => {
    expect(matchingDeliveryScoringSourceSchema.parse(source)).toEqual({
      ...source,
      acceptedBlanks: [["slot,甲"], ["opt,共同"], ["slot=乙"], ["opt,共同"]],
    });
    expect(
      wholeQuestionDeliveryScoringSourcesSchema.safeParse([source]).success,
    ).toBe(true);
    expect(
      questionDeliveryScoringSourcesSchema.safeParse([source]).success,
    ).toBe(false);
  });

  it("拒绝无实际映射、无选项池或参考引用池外选项", () => {
    for (const changes of [
      { answers: undefined },
      { answers: { kind: "matching", pairs: {} } },
      { answers: { kind: "matching", pairs: { "slot=乙": "未知" } } },
      { matchingOptions: undefined },
    ]) {
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.safeParse([
          { ...source, ...changes },
        ]).success,
      ).toBe(false);
    }
  });

  it("整卷可冻结有材料槽位的无参考配对，且不会把坏参考降级为无参考", () => {
    const { answers: _reference, ...options } = source;
    const unkeyed = {
      ...options,
      materialRefs: [{ material: "听力材料", slots: "slot-1..slot-5" }],
    };
    expect(wholeQuestionDeliveryScoringSourcesSchema.parse([unkeyed])).toEqual([
      unkeyed,
    ]);
    for (const invalid of [
      { ...unkeyed, answers: null },
      { ...unkeyed, answers: { kind: "matching", pairs: {} } },
      { ...unkeyed, answers: { kind: "choice", index: 0 } },
      { ...unkeyed, matchingOptions: undefined },
      { ...unkeyed, materialRefs: [{ material: "听力材料" }] },
    ]) {
      expect(
        wholeQuestionDeliveryScoringSourcesSchema.safeParse([invalid]).success,
      ).toBe(false);
    }
    expect(
      questionDeliveryScoringSourcesSchema.safeParse([unkeyed]).success,
    ).toBe(false);
  });

  it("按槽位确定编码，保留原值、重复选项和空映射，拒绝损坏的槽位序列", () => {
    const pairs = { "slot=乙": "opt,共同", "slot,甲": "opt=干扰" };
    const value = matchingDeliveryValueOf(pairs);
    expect(value).toEqual(["slot,甲", "opt=干扰", "slot=乙", "opt,共同"]);
    expect(matchingDeliveryAnswerSchema.parse(value)).toEqual({
      kind: "matching",
      pairs,
    });
    for (const answer of [source.answers, { kind: "matching", pairs: {} }]) {
      expect(
        matchingDeliveryAnswerSchema.parse(
          matchingDeliveryValueOf(answer.pairs),
        ),
      ).toEqual(answer);
    }
    for (const malformed of [
      ["slot"],
      ["slot", ""],
      ["slot", "option", "slot", "other"],
      [0, "option"],
    ]) {
      expect(matchingDeliveryAnswerSchema.safeParse(malformed).success).toBe(
        false,
      );
    }
  });
});
