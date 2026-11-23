import {
  type GradingPolicy,
  type Question,
  questionCapabilityBindings,
  questionTypeSchema,
  resolveRowGradingPolicy,
  resolveSelfReviewState,
  type StudentAnswer,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { grade } from "./grade.ts";
import { gradeResponseRow } from "./grade-row.ts";

/**
 * QM-10 细项 1/2（TT-09a，决策记录 §5.6 D11）：行级判分入口——新作答取消
 * 主观自动匹配。fill 与 solve/apply/find-error 的新策略行（reference_self /
 * manual_only）对 reference 相同、等价、不同、空白四种情形都不产生 autoCorrect
 * 主观匹配判定；旧行（gradingPolicy=NULL）与客观题新行（auto）按题型能力表
 * 原规则（solve 等价比较、fill 恒 null、choice/judge/multi 自动判定）。
 * TASK-f9439bfd 起空/非法策略行一律回落开卷冻结的默认策略，不再保留旧语义。
 */

function makeQuestion(partial: {
  type: Question["type"];
  answers?: Question["answers"];
  options?: Question["options"];
}): Question {
  return {
    id: "test-1",
    type: partial.type,
    difficulty: 2,
    knowledge: ["测试考点"],
    stemMd: "测试题干",
    ...(partial.options !== undefined ? { options: partial.options } : {}),
    ...(partial.answers !== undefined ? { answers: partial.answers } : {}),
    hints: [],
    sourceMd: "测试原文",
  };
}

/** 手写题（solve/apply/find-error 共享 gradeHandwritten）：参考 0.5 */
const handwrittenWithAnswer = (type: "solve" | "apply" | "find-error") =>
  makeQuestion({ type, answers: { kind: "final", answer: "0.5" } });

/** 手写题四种作答形态：相同 / 等价 / 不同 / 空白 */
const handwrittenAnswers: ReadonlyArray<[string, StudentAnswer | undefined]> = [
  ["相同", { kind: "final", finalAnswer: "0.5" }],
  ["等价", { kind: "final", finalAnswer: "1/2" }],
  ["不同", { kind: "final", finalAnswer: "3" }],
  ["空白", { kind: "final", finalAnswer: "  " }],
];

/** 填空题：参考单空等价答案列表 */
const fillWithBlanks = makeQuestion({
  type: "fill",
  answers: { kind: "fill", blanks: [["0.5", "1/2"]] },
});

/** 填空题四种作答形态（同款四情形口径） */
const fillAnswers: ReadonlyArray<[string, StudentAnswer | undefined]> = [
  ["相同", { kind: "fill", values: ["0.5"] }],
  ["等价", { kind: "fill", values: ["1/2"] }],
  ["不同", { kind: "fill", values: ["3"] }],
  ["空白", { kind: "fill", values: [""] }],
];

describe("gradeResponseRow：新策略行取消主观匹配（QM-10 细项 1）", () => {
  for (const policy of ["reference_self", "manual_only"] as const) {
    describe(`${policy} 行`, () => {
      for (const [label, answer] of handwrittenAnswers) {
        it(`solve 最终答案与参考${label} → null（不自动判）`, () => {
          expect(
            gradeResponseRow(policy, handwrittenWithAnswer("solve"), answer),
          ).toBeNull();
        });
      }

      it("apply/find-error 同款四情形（共享实现不复制算法）", () => {
        for (const type of ["apply", "find-error"] as const) {
          for (const [, answer] of handwrittenAnswers) {
            expect(
              gradeResponseRow(policy, handwrittenWithAnswer(type), answer),
            ).toBeNull();
          }
        }
      });

      for (const [label, answer] of fillAnswers) {
        it(`fill 作答与参考${label} → null`, () => {
          expect(gradeResponseRow(policy, fillWithBlanks, answer)).toBeNull();
        });
      }

      it("手写题未作答（answer 缺省）→ null（不判错）", () => {
        expect(
          gradeResponseRow(policy, handwrittenWithAnswer("solve"), undefined),
        ).toBeNull();
      });

      it("无参考答案（manual_only 的常态）→ null", () => {
        expect(
          gradeResponseRow(policy, makeQuestion({ type: "solve" }), {
            kind: "final",
            finalAnswer: "0.5",
          }),
        ).toBeNull();
      });

      it("新题型（response/matching/ordering）→ null（细项 2 非自动）", () => {
        const question = makeQuestion({
          type: "response",
          answers: {
            kind: "response",
            referenceMd: "参考范文",
          },
        });
        expect(
          gradeResponseRow(policy, question, {
            kind: "response",
            body: "参考范文",
          }),
        ).toBeNull();
      });
    });
  }
});

describe("gradeResponseRow：客观题 auto 行按原校验器", () => {
  it("auto 行 choice/judge 照旧，未作答客观题判错（D1）", () => {
    const choice = makeQuestion({
      type: "choice",
      answers: { kind: "choice", index: 0 },
      options: [{ text: "A" }, { text: "B" }],
    });
    expect(gradeResponseRow("auto", choice, { kind: "choice", index: 0 })).toBe(
      true,
    );
    expect(gradeResponseRow("auto", choice, { kind: "choice", index: 1 })).toBe(
      false,
    );
    expect(gradeResponseRow("auto", choice, undefined)).toBe(false);
    const judge = makeQuestion({
      type: "judge",
      answers: { kind: "judge", value: true },
    });
    expect(
      gradeResponseRow("auto", judge, { kind: "judge", value: true }),
    ).toBe(true);
  });
});

describe("gradeResponseRow：空/非法策略回落默认策略（TASK-f9439bfd）", () => {
  it("空策略 solve 行不再走 final 等价比较：与 reference_self 新行同为 null", () => {
    for (const [, answer] of handwrittenAnswers) {
      expect(
        gradeResponseRow(null, handwrittenWithAnswer("solve"), answer),
      ).toBeNull();
    }
  });

  it("空策略 fill 行按默认策略（有参考 reference_self）恒 null", () => {
    expect(
      gradeResponseRow(null, fillWithBlanks, { kind: "fill", values: ["0.5"] }),
    ).toBeNull();
  });

  it("空策略客观题回落 auto，与冻结 auto 行等价", () => {
    const judge = makeQuestion({
      type: "judge",
      answers: { kind: "judge", value: false },
    });
    expect(gradeResponseRow(null, judge, { kind: "judge", value: false })).toBe(
      true,
    );
    expect(gradeResponseRow(null, judge, undefined)).toBe(false);
  });

  /** 每种题型：带参考快照 + 与参考一致的作答（最可能被误判对的输入） */
  const casesByType: ReadonlyArray<
    readonly [Question["type"], Question["answers"], StudentAnswer]
  > = [
    ["judge", { kind: "judge", value: true }, { kind: "judge", value: true }],
    ["choice", { kind: "choice", index: 0 }, { kind: "choice", index: 0 }],
    ["multi", { kind: "multi", indexes: [0] }, { kind: "multi", indexes: [0] }],
    [
      "fill",
      { kind: "fill", blanks: [["1"]] },
      { kind: "fill", values: ["1"] },
    ],
    [
      "solve",
      { kind: "final", answer: "1" },
      { kind: "final", finalAnswer: "1" },
    ],
    [
      "apply",
      { kind: "final", answer: "1" },
      { kind: "final", finalAnswer: "1" },
    ],
    [
      "find-error",
      { kind: "final", answer: "1" },
      { kind: "final", finalAnswer: "1" },
    ],
    [
      "response",
      { kind: "response", referenceMd: "参考" },
      { kind: "response", body: "参考" },
    ],
    [
      "matching",
      { kind: "matching", pairs: { s1: "o1" } },
      { kind: "matching", pairs: { s1: "o1" } },
    ],
    [
      "ordering",
      { kind: "ordering", sequence: ["a"] },
      { kind: "ordering", sequence: ["a"] },
    ],
  ];

  it("covers：每种题型 × 空/非法策略 × 快照有无参考 × 作答有无：不抛错，终态为已判或待处理", () => {
    expect(casesByType.map(([type]) => type)).toEqual(
      questionTypeSchema.options,
    );
    const stored = [null, undefined, "", "legacy", "AUTO"] as const;
    for (const [type, answers, answer] of casesByType) {
      for (const question of [
        makeQuestion({ type, answers, options: [{ text: "A" }] }),
        makeQuestion({ type, options: [{ text: "A" }] }),
      ]) {
        const policy = resolveRowGradingPolicy(null, question);
        for (const value of stored) {
          for (const given of [answer, undefined]) {
            const result = gradeResponseRow(
              value as GradingPolicy | null,
              question,
              given,
            );
            expect([true, false, null]).toContain(result);
            // 结果与按默认策略冻结的新行逐一相同（无独立旧语义分支）
            expect(result).toBe(gradeResponseRow(policy, question, given));
            // 非 auto 策略不产生自动判定（不伪造对错）
            if (policy !== "auto") expect(result).toBeNull();
            const state = resolveSelfReviewState({
              submitted: true,
              released: true,
              autoCorrect: result,
              teacherMark: null,
              selfReview: null,
              hasReference: policy === "reference_self",
            });
            expect([
              "auto_judged",
              "self_pending",
              "teacher_pending",
            ]).toContain(state);
          }
        }
      }
    }
  });
});

describe("能力面：旧客观题按原规则、主观与新题型非自动（QM-10 细项 2）", () => {
  it("旧客观题（judge/choice/multi/solve/apply/find-error）validation.shape 保持 exact", () => {
    for (const type of [
      "judge",
      "choice",
      "multi",
      "solve",
      "apply",
      "find-error",
    ] as const) {
      expect(questionCapabilityBindings[type].validation.shape).toBe("exact");
    }
  });

  it("fill 与新题型（response/matching/ordering）非 exact（rubric 恒人工）", () => {
    for (const type of ["fill", "response", "matching", "ordering"] as const) {
      expect(questionCapabilityBindings[type].validation.shape).not.toBe(
        "exact",
      );
    }
  });

  it("grade() 本体不变：新题型经 shape 短路恒 null（gradeResponseRow 与之同 null）", () => {
    const question = makeQuestion({
      type: "matching",
      answers: {
        kind: "matching",
        pairs: { s1: "o1" },
      },
    });
    const answer: StudentAnswer = { kind: "matching", pairs: { s1: "o1" } };
    expect(grade(question, answer)).toBeNull();
    expect(gradeResponseRow("reference_self", question, answer)).toBeNull();
  });
});
