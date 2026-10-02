import { describe, expect, it } from "vitest";
import {
  wrongQuestionCardSchema,
  wrongQuestionRoundSchema,
  wrongQuestionsOkSchema,
  wrongQuestionsQuerySchema,
} from "./student-records-api.ts";

/**
 * 学生端「我的记录/错题本」契约测试（T3.5 起；2026-10 错题本升级补齐）：
 * - 查询参数 stringbool（includeResolved）与 knowledge 空串拒绝；
 * - 错题本条目 2026-10 新字段：rounds（轮次史元素类型）、wrongCount/correctCount、
 *   originUnitId/originUnitTitle（归属单元，与「最近来源上下文」字段语义区分）
 *   的类型与缺省（必填缺失不通过、null 只允许出现在可空字段）。
 * 契约是前后端唯一事实来源（AGENTS 第 1 条），服务端路由测试共用同一份定义。
 */

const UUID = "0199aaaa-1111-4222-8333-444455556666";

/** 合法的轮次元素样例（课程练习第 2 轮做对） */
const roundFixture = {
  attemptId: UUID,
  sourceType: "course",
  correct: true,
  submittedAt: "2026-10-01T02:00:00.000Z",
  sourceTitle: "有理数课程练习 · 第 2 次",
  courseName: "初一上",
};

/** 合法的错题本条目样例（course 来源；含全部 2026-10 新字段） */
function cardFixture(): Record<string, unknown> {
  return {
    sourceType: "course",
    courseId: UUID,
    courseName: "初一上",
    assignmentId: null,
    assignmentTitle: null,
    unitId: "有理数课程练习",
    unitTitle: "有理数课程练习",
    attemptNo: 2,
    questionId: "有理数课程练习-1",
    type: "judge",
    difficulty: 1,
    knowledge: ["有理数的概念"],
    stemMd: "$1$ 是正数。[[正确]]",
    answers: { kind: "judge", value: true },
    solutionMd: null,
    answerText: "错误",
    firstCorrect: false,
    resolved: false,
    firstAt: "2026-09-28T02:00:00.000Z",
    lastAt: "2026-10-01T02:00:00.000Z",
    rounds: [
      {
        attemptId: UUID,
        sourceType: "course",
        correct: false,
        submittedAt: "2026-09-28T02:00:00.000Z",
        sourceTitle: "有理数课程练习 · 第 1 次",
        courseName: "初一上",
      },
      roundFixture,
    ],
    wrongCount: 1,
    correctCount: 1,
    originUnitId: "有理数课程练习",
    originUnitTitle: "有理数课程练习",
  };
}

describe("wrongQuestionsQuerySchema（查询参数）", () => {
  it("includeResolved 走 stringbool（'true'/'false' → 布尔）；空对象全缺省", () => {
    expect(wrongQuestionsQuerySchema.parse({})).toEqual({});
    expect(
      wrongQuestionsQuerySchema.parse({ includeResolved: "true" }),
    ).toEqual({ includeResolved: true });
  });

  it("knowledge 空串与非法 stringbool 拒绝", () => {
    expect(wrongQuestionsQuerySchema.safeParse({ knowledge: "" }).success).toBe(
      false,
    );
    expect(
      wrongQuestionsQuerySchema.safeParse({ includeResolved: "maybe" }).success,
    ).toBe(false);
  });
});

describe("wrongQuestionRoundSchema（轮次史元素）", () => {
  it("合法样例通过；sourceTitle/courseName 与 submittedAt 有值", () => {
    const parsed = wrongQuestionRoundSchema.parse(roundFixture);
    expect(parsed.correct).toBe(true);
    expect(parsed.sourceTitle).toBe("有理数课程练习 · 第 2 次");
  });

  it("courseName 可 null；类型不符拒绝（correct 非布尔、空 sourceTitle、非法 sourceType、空时间）", () => {
    expect(
      wrongQuestionRoundSchema.safeParse({ ...roundFixture, courseName: null })
        .success,
    ).toBe(true);
    for (const bad of [
      { ...roundFixture, correct: "yes" },
      { ...roundFixture, sourceTitle: "" },
      { ...roundFixture, sourceType: "exam" },
      { ...roundFixture, submittedAt: "" },
      { ...roundFixture, attemptId: "not-a-uuid" },
    ] as const) {
      expect(
        wrongQuestionRoundSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("任一必填键缺失不通过（缺省不允许）", () => {
    for (const key of Object.keys(roundFixture)) {
      const partial = { ...roundFixture } as Record<string, unknown>;
      delete partial[key];
      expect(
        wrongQuestionRoundSchema.safeParse(partial).success,
        `缺少 ${key}`,
      ).toBe(false);
    }
  });
});

describe("wrongQuestionCardSchema（2026-10 新字段）", () => {
  it("含 rounds/wrongCount/correctCount/originUnitId/originUnitTitle 的完整条目通过", () => {
    const parsed = wrongQuestionCardSchema.parse(cardFixture());
    expect(parsed.rounds).toHaveLength(2);
    expect(parsed.rounds[0]?.correct).toBe(false);
    expect(parsed.wrongCount).toBe(1);
    expect(parsed.correctCount).toBe(1);
    expect(parsed.originUnitId).toBe("有理数课程练习");
  });

  it("归属单元两字段可 null（题目行/单元行缺失的防御）；来源上下文字段照常必填可空", () => {
    const parsed = wrongQuestionCardSchema.parse({
      ...cardFixture(),
      originUnitId: null,
      originUnitTitle: null,
    });
    expect(parsed.originUnitId).toBeNull();
    expect(parsed.originUnitTitle).toBeNull();
  });

  it("新字段缺省不通过；wrongCount/correctCount 拒绝非负整数以外形态；rounds 拒绝坏元素", () => {
    const base = cardFixture();
    for (const key of [
      "rounds",
      "wrongCount",
      "correctCount",
      "originUnitId",
      "originUnitTitle",
    ] as const) {
      const partial = { ...base };
      delete partial[key];
      expect(wrongQuestionCardSchema.safeParse(partial).success, key).toBe(
        false,
      );
    }
    for (const bad of [
      { ...base, wrongCount: -1 },
      { ...base, wrongCount: 1.5 },
      { ...base, correctCount: "2" },
      { ...base, originUnitId: "" },
      { ...base, originUnitTitle: 0 },
      { ...base, rounds: [{ ...roundFixture, correct: 1 }] },
    ] as const) {
      expect(
        wrongQuestionCardSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("响应壳 wrongQuestionsOkSchema 随新字段形态通过（data.questions 数组）", () => {
    expect(
      wrongQuestionsOkSchema.safeParse({
        ok: true,
        data: { questions: [cardFixture()] },
      }).success,
    ).toBe(true);
  });
});
