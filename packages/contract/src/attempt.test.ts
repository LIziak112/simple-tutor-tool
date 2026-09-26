import { describe, expect, it } from "vitest";
import {
  attemptAnswerSaveDataSchema,
  attemptAnswerSaveRequestSchema,
  attemptDetailDataSchema,
  attemptDraftDataSchema,
  attemptErrorCodeSchema,
  attemptResultDataSchema,
  attemptStartDataSchema,
  attemptStatusSchema,
  attemptSummarySchema,
} from "./attempt.ts";

/**
 * 作答生命周期契约自测（T2.6）：锁定四个接口的请求/响应形态——
 * - attempt 摘要三态与 scoreAuto 口径（0–100 整数或 null）；
 * - 草稿视图：题目是 QuestionPublic 形态（无 answers/solutionMd/hints）、
 *   本人答案收在 drafts 键（键名与结果视图的参考答案 answers 区分）；
 * - 结果视图：快照 + 参考答案 + 详解 + 本人答案 + autoCorrect，但无提示内容键；
 * - 草稿保存请求体：answer 必须是 StudentAnswer 判别联合成员；
 * - 错误码集合（ALREADY_SUBMITTED 为 T2.6 验收项）。
 */

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const UNIT_ID = "练习四";
const STARTED_AT = "2026-09-27T02:00:00.000Z";
const SUBMITTED_AT = "2026-09-27T02:30:00.000Z";

const SUMMARY_DRAFT = {
  id: ATTEMPT_ID,
  assignmentId: ASSIGNMENT_ID,
  unitId: UNIT_ID,
  status: "draft",
  startedAt: STARTED_AT,
  submittedAt: null,
  scoreAuto: null,
} as const;

const SUMMARY_SUBMITTED = {
  ...SUMMARY_DRAFT,
  status: "submitted",
  submittedAt: SUBMITTED_AT,
  scoreAuto: 88,
} as const;

describe("attemptStatusSchema / attemptSummarySchema", () => {
  it("接受三态 draft|submitted|graded，拒绝其他值", () => {
    expect(attemptStatusSchema.parse("draft")).toBe("draft");
    expect(attemptStatusSchema.parse("submitted")).toBe("submitted");
    expect(attemptStatusSchema.parse("graded")).toBe("graded");
    expect(attemptStatusSchema.safeParse("in_progress").success).toBe(false);
  });

  it("摘要：scoreAuto 是 0–100 整数或 null；submittedAt 可空", () => {
    expect(attemptSummarySchema.parse(SUMMARY_DRAFT).scoreAuto).toBeNull();
    const submitted = attemptSummarySchema.parse(SUMMARY_SUBMITTED);
    expect(submitted.scoreAuto).toBe(88);
    expect(submitted.submittedAt).toBe(SUBMITTED_AT);
    expect(
      attemptSummarySchema.safeParse({ ...SUMMARY_DRAFT, scoreAuto: 101 })
        .success,
    ).toBe(false);
    expect(
      attemptSummarySchema.safeParse({ ...SUMMARY_DRAFT, scoreAuto: 88.5 })
        .success,
    ).toBe(false);
  });

  it("POST /attempt 响应 = 摘要本体（attemptStartDataSchema）", () => {
    expect(attemptStartDataSchema.parse(SUMMARY_DRAFT)).toEqual(SUMMARY_DRAFT);
  });
});

describe("attemptDraftDataSchema（草稿视图）", () => {
  it("接受合法草稿视图：QuestionPublic 形态题目 + drafts 答案表", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      dueAt: null,
      questions: [
        {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
        },
        {
          id: "练习四-4",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]",
          hintCount: 1,
        },
      ],
      drafts: {
        "练习四-1": { kind: "judge", value: true },
        "练习四-4": { kind: "fill", values: ["4", ""] },
      },
    });
    expect(parsed.drafts["练习四-1"]).toEqual({ kind: "judge", value: true });
  });

  it("草稿视图里的题目携带教师侧字段会被剥离（strip 语义，与 QuestionPublic 一致）", () => {
    const parsed = attemptDraftDataSchema.parse({
      attempt: SUMMARY_DRAFT,
      title: "周末加练",
      dueAt: null,
      questions: [
        {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: [],
          stemMd: "[[]]",
          hintCount: 0,
          // 教师侧字段混入草稿视图题目 → 契约层剥离（fail closed：只少给不多给）
          answers: { kind: "judge", value: true },
          solutionMd: "详解不应出现在草稿视图",
        },
      ],
      drafts: {},
    });
    const question = parsed.questions[0];
    expect(question && "answers" in question).toBe(false);
    expect(question && "solutionMd" in question).toBe(false);
  });
});

describe("attemptResultDataSchema（结果视图）", () => {
  const RESULT = {
    attempt: SUMMARY_SUBMITTED,
    title: "周末加练",
    dueAt: null,
    summary: {
      total: 2,
      answered: 2,
      correct: 1,
      wrong: 1,
      pending: 0,
      unanswered: 0,
      autoGradable: 2,
    },
    questions: [
      {
        questionId: "练习四-1",
        snapshot: {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
          hintCount: 0,
        },
        answers: { kind: "judge", value: true },
        solutionMd: "$0$ 是整数，但既不是正数也不是负数。",
        answer: { kind: "judge", value: true },
        autoCorrect: true,
      },
      {
        questionId: "练习四-4",
        snapshot: {
          id: "练习四-4",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[4]]",
          hintCount: 1,
        },
        answers: { kind: "fill", blanks: [["4"], ["-7"], ["0.5", "1/2"]] },
        solutionMd: null,
        answer: { kind: "fill", values: ["4", "-6", ""] },
        autoCorrect: false,
      },
    ],
  } as const;

  it("接受合法结果视图：快照 + 参考答案 + 详解 + 本人答案 + autoCorrect", () => {
    const parsed = attemptResultDataSchema.parse(RESULT);
    expect(parsed.questions[0]?.autoCorrect).toBe(true);
    expect(parsed.questions[1]?.answers).toEqual({
      kind: "fill",
      blanks: [["4"], ["-7"], ["0.5", "1/2"]],
    });
  });

  it("快照携带提示内容字段会被剥离（strip 语义；hintCount 是唯一提示形态）", () => {
    const parsed = attemptResultDataSchema.parse({
      ...RESULT,
      questions: [
        {
          ...RESULT.questions[0],
          snapshot: {
            ...RESULT.questions[0].snapshot,
            hints: ["提示内容不应出现在结果视图"],
          },
        },
      ],
    });
    const snapshot = parsed.questions[0]?.snapshot;
    expect(snapshot && "hints" in snapshot).toBe(false);
    expect(snapshot?.hintCount).toBe(0);
  });

  it("autoCorrect / answer 允许 null（未作答或待批）；answers 允许 null（无标准答案）", () => {
    expect(
      attemptResultDataSchema.safeParse({
        ...RESULT,
        questions: [
          {
            questionId: "p4-q7",
            snapshot: {
              id: "p4-q7",
              type: "solve",
              difficulty: 3,
              knowledge: [],
              stemMd: "计算 …",
              hintCount: 0,
            },
            answers: null,
            solutionMd: null,
            answer: null,
            autoCorrect: null,
          },
        ],
        summary: {
          total: 1,
          answered: 0,
          correct: 0,
          wrong: 0,
          pending: 1,
          unanswered: 1,
          autoGradable: 0,
        },
      }).success,
    ).toBe(true);
  });
});

describe("attemptAnswerSaveRequestSchema / attemptAnswerSaveDataSchema", () => {
  it("请求体 answer 必须是 StudentAnswer 判别联合成员", () => {
    expect(
      attemptAnswerSaveRequestSchema.parse({
        answer: { kind: "choice", index: 1 },
      }),
    ).toEqual({ answer: { kind: "choice", index: 1 } });
    expect(
      attemptAnswerSaveRequestSchema.safeParse({
        answer: { kind: "choice", index: -1 },
      }).success,
    ).toBe(false);
    expect(
      attemptAnswerSaveRequestSchema.safeParse({ answer: "B" }).success,
    ).toBe(false);
  });

  it("保存回执：questionId + changeCount（≥1）", () => {
    expect(
      attemptAnswerSaveDataSchema.parse({
        questionId: "练习四-1",
        changeCount: 2,
      }),
    ).toEqual({ questionId: "练习四-1", changeCount: 2 });
    expect(
      attemptAnswerSaveDataSchema.safeParse({
        questionId: "练习四-1",
        changeCount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("attemptDetailDataSchema / attemptErrorCodeSchema", () => {
  it("详情 data 是草稿视图与结果视图的 union（按 attempt.status 分支）", () => {
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_DRAFT,
        title: "周末加练",
        dueAt: null,
        questions: [],
        drafts: {},
      }).success,
    ).toBe(true);
    expect(
      attemptDetailDataSchema.safeParse({
        attempt: SUMMARY_SUBMITTED,
        title: "周末加练",
        dueAt: null,
        summary: {
          total: 0,
          answered: 0,
          correct: 0,
          wrong: 0,
          pending: 0,
          unanswered: 0,
          autoGradable: 0,
        },
        questions: [],
      }).success,
    ).toBe(true);
  });

  it("错误码集合含 ALREADY_SUBMITTED（T2.6 验收项）与越权/不存在码", () => {
    expect(attemptErrorCodeSchema.parse("ALREADY_SUBMITTED")).toBe(
      "ALREADY_SUBMITTED",
    );
    expect(attemptErrorCodeSchema.parse("ATTEMPT_NOT_FOUND")).toBe(
      "ATTEMPT_NOT_FOUND",
    );
    expect(attemptErrorCodeSchema.parse("QUESTION_NOT_FOUND")).toBe(
      "QUESTION_NOT_FOUND",
    );
    expect(attemptErrorCodeSchema.safeParse("SUBMIT_TWICE").success).toBe(
      false,
    );
  });
});
