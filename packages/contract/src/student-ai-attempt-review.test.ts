import { describe, expect, it } from "vitest";
import {
  AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS,
  AI_ATTEMPT_REVIEW_MAX_QUESTIONS,
  type AiAttemptReviewQuestion,
  aiAttemptReviewCountsSchema,
  aiAttemptReviewCreateRequestSchema,
  aiAttemptReviewFindingSchema,
  aiAttemptReviewQuestionSchema,
  aiAttemptReviewReportSchema,
  aiAttemptReviewSnapshotSchema,
} from "./student-ai-attempt-review.ts";

/**
 * 本次练习整体复盘契约自测（任务 1ef854c7）：锁定互斥四桶不变式、
 * 展示桶与作答态/判分态一致性、快照整体不变式（题号连续/版本锚定唯一/
 * 计数对齐）、报告形状与请求 strict 口径——服务端构造的数据必须先过
 * 这里，才允许进出站/领取视图。
 */

const ATTEMPT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function questionOf(
  overrides: Partial<AiAttemptReviewQuestion> = {},
): AiAttemptReviewQuestion {
  return {
    questionNo: 1,
    questionId: "q1",
    questionRevisionId: "rev-1",
    questionType: "choice",
    stemMd: "题干",
    knowledgePoints: [],
    difficulty: 3,
    studentAnswerText: null,
    referenceAnswerMd: null,
    solutionMd: null,
    missingNote: "neither" as const,
    answerState: "answered" as const,
    gradingState: "correct" as const,
    displayStatus: "correct" as const,
    hasFormalInk: false,
    activeSec: 30,
    notes: [],
    ...overrides,
  };
}

function countsOf(
  overrides: Partial<{
    total: number;
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    pendingCount: number;
    unknownAnswerCount: number;
    hasAnswerCount: number;
    missingAnswerCount: number;
    gradedCount: number;
    accuracyAmongGraded: number | null;
  }>,
) {
  return {
    total: 3,
    correctCount: 1,
    incorrectCount: 1,
    unansweredCount: 1,
    pendingCount: 0,
    unknownAnswerCount: 0,
    hasAnswerCount: 2,
    missingAnswerCount: 1,
    gradedCount: 2,
    accuracyAmongGraded: 0.5,
    ...overrides,
  };
}

describe("整体复盘四桶计数不变式", () => {
  it("互斥四桶加总等于总题数，已判分准确率带分母", () => {
    const parsed = aiAttemptReviewCountsSchema.parse(countsOf({}));
    expect(parsed.total).toBe(3);
    expect(parsed.gradedCount).toBe(2);
  });

  it("四桶之和不等于总题数 → 拒绝", () => {
    const result = aiAttemptReviewCountsSchema.safeParse(
      countsOf({ pendingCount: 1 }),
    );
    expect(result.success).toBe(false);
  });

  it("gradedCount=0 时准确率必须为 null（不用 0% 假报）", () => {
    const zeroGraded = aiAttemptReviewCountsSchema.safeParse(
      countsOf({
        correctCount: 0,
        incorrectCount: 0,
        gradedCount: 0,
        unansweredCount: 2,
        pendingCount: 1,
        accuracyAmongGraded: 0,
      }),
    );
    expect(zeroGraded.success).toBe(false);

    const okNull = aiAttemptReviewCountsSchema.safeParse(
      countsOf({
        correctCount: 0,
        incorrectCount: 0,
        gradedCount: 0,
        unansweredCount: 2,
        pendingCount: 1,
        accuracyAmongGraded: null,
      }),
    );
    expect(okNull.success).toBe(true);
  });

  it("unknownAnswerCount 超过待批桶 → 拒绝（unknown 不假报纯待批）", () => {
    const result = aiAttemptReviewCountsSchema.safeParse(
      countsOf({ unknownAnswerCount: 1 }),
    );
    expect(result.success).toBe(false);
  });

  it("作答态三桶（已答/未答/无法核对）之和必须等于总题数", () => {
    // 3 题：1 判错（已答）+ 1 未答 + 1 无法核对（计入待批）——三桶 1+1+1=3
    const ok = aiAttemptReviewCountsSchema.safeParse(
      countsOf({
        total: 3,
        correctCount: 0,
        incorrectCount: 1,
        unansweredCount: 1,
        pendingCount: 1,
        unknownAnswerCount: 1,
        hasAnswerCount: 1,
        missingAnswerCount: 1,
        gradedCount: 1,
        accuracyAmongGraded: 0,
      }),
    );
    expect(ok.success).toBe(true);
    // unknown 缺位（1+1+0 ≠ 3）→ 拒绝
    const missingUnknown = aiAttemptReviewCountsSchema.safeParse(
      countsOf({
        total: 3,
        correctCount: 0,
        incorrectCount: 1,
        unansweredCount: 1,
        pendingCount: 1,
        unknownAnswerCount: 0,
        hasAnswerCount: 1,
        missingAnswerCount: 1,
        gradedCount: 1,
        accuracyAmongGraded: 0,
      }),
    );
    expect(missingUnknown.success).toBe(false);
  });
});

describe("每题展示桶与两态一致性", () => {
  it("correct/incorrect ⇔ gradingState 同值", () => {
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({ gradingState: "pending" }),
      ).success,
    ).toBe(false);
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({ displayStatus: "incorrect", gradingState: "incorrect" }),
      ).success,
    ).toBe(true);
  });

  it("unanswered 桶要求判分待定且作答态为未作答", () => {
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({
          displayStatus: "unanswered",
          gradingState: "pending",
          answerState: "unanswered",
          studentAnswerText: null,
        }),
      ).success,
    ).toBe(true);
    // 判错且无作答 → 保留 incorrect，不当未做
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({
          gradingState: "incorrect",
          displayStatus: "incorrect",
          answerState: "unanswered",
          studentAnswerText: null,
        }),
      ).success,
    ).toBe(true);
  });

  it("unknown 作答态只能进待批桶", () => {
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({
          answerState: "unknown",
          gradingState: "pending",
          displayStatus: "pending",
        }),
      ).success,
    ).toBe(true);
    expect(
      aiAttemptReviewQuestionSchema.safeParse(
        questionOf({
          answerState: "unknown",
          gradingState: "pending",
          displayStatus: "unanswered",
        }),
      ).success,
    ).toBe(false);
  });
});

describe("整体快照不变式", () => {
  it("题号必须 1 起连续，questionCount 与题目数一致", () => {
    const base = {
      schemaVersion: 1 as const,
      attemptId: ATTEMPT_ID,
      snapshotVersion: "v1-abc",
      capturedAt: "2026-10-24T00:00:00.000Z",
      purpose: "帮我复盘",
      questionCount: 2,
      counts: countsOf({
        total: 2,
        correctCount: 1,
        incorrectCount: 0,
        unansweredCount: 0,
        pendingCount: 1,
        gradedCount: 1,
        accuracyAmongGraded: 1,
        hasAnswerCount: 2,
        missingAnswerCount: 0,
      }),
      questions: [
        questionOf(),
        questionOf({
          questionNo: 2,
          questionId: "q2",
          questionRevisionId: "rev-2",
          gradingState: "pending",
          displayStatus: "pending",
        }),
      ],
      notes: [],
    };
    expect(aiAttemptReviewSnapshotSchema.safeParse(base).success).toBe(true);

    const badNo = aiAttemptReviewSnapshotSchema.safeParse({
      ...base,
      questions: [base.questions[0], { ...base.questions[1], questionNo: 3 }],
    });
    expect(badNo.success).toBe(false);

    const badCount = aiAttemptReviewSnapshotSchema.safeParse({
      ...base,
      questionCount: 3,
    });
    expect(badCount.success).toBe(false);

    // 版本锚定重复 → 拒绝
    const dupRevision = aiAttemptReviewSnapshotSchema.safeParse({
      ...base,
      questions: [
        base.questions[0],
        { ...base.questions[1], questionRevisionId: "rev-1" },
      ],
    });
    expect(dupRevision.success).toBe(false);
  });

  it("strict：未知键整体拒绝（教师私注等内部字段无进入路径）", () => {
    const result = aiAttemptReviewSnapshotSchema.safeParse({
      schemaVersion: 1,
      attemptId: ATTEMPT_ID,
      snapshotVersion: "v1-abc",
      capturedAt: "2026-10-24T00:00:00.000Z",
      purpose: "帮我复盘",
      questionCount: 1,
      counts: countsOf({
        total: 1,
        correctCount: 1,
        incorrectCount: 0,
        unansweredCount: 0,
        pendingCount: 0,
        gradedCount: 1,
        accuracyAmongGraded: 1,
        hasAnswerCount: 1,
        missingAnswerCount: 0,
      }),
      questions: [questionOf()],
      notes: [],
      teacherComment: "教师私注",
    });
    expect(result.success).toBe(false);
  });
});

describe("结构化报告与请求口径", () => {
  it("finding 支持事实/假设区分与置信度", () => {
    expect(
      aiAttemptReviewFindingSchema.safeParse({
        statement: "一元一次方程移项符号出错",
        evidenceQuestionNos: [2, 5],
        basis: "ai_hypothesis",
        confidence: "medium",
      }).success,
    ).toBe(true);
    expect(
      aiAttemptReviewFindingSchema.safeParse({
        statement: "x",
        evidenceQuestionNos: [],
        basis: "platform_fact",
        confidence: "unknown",
      }).success,
    ).toBe(false);
  });

  it("报告 strict：五个维度 + limitations，未知键拒绝", () => {
    const finding = {
      statement: "整体完成度高",
      evidenceQuestionNos: [1],
      basis: "platform_fact" as const,
      confidence: "high" as const,
    };
    const ok = aiAttemptReviewReportSchema.safeParse({
      schemaVersion: 1,
      overview: "本次练习覆盖 3 题",
      knowledgeFindings: [finding],
      errorPatterns: [],
      performanceNotes: [],
      trainingPlan: [],
      limitations: ["一次练习不能代表长期能力"],
    });
    expect(ok.success).toBe(true);
    expect(
      aiAttemptReviewReportSchema.safeParse({
        schemaVersion: 1,
        overview: "x",
        knowledgeFindings: [],
        errorPatterns: [],
        performanceNotes: [],
        trainingPlan: [],
        limitations: [],
        score: 88,
      }).success,
    ).toBe(false);
  });

  it("创建请求 strict：channel 只接受 mcp，未知字段拒绝", () => {
    const ok = aiAttemptReviewCreateRequestSchema.safeParse({
      attemptId: ATTEMPT_ID,
      mutationId: "m-1",
      expectedPreviewVersion: "v1-abc",
      purpose: "整体复盘",
      channel: "mcp",
    });
    expect(ok.success).toBe(true);
    expect(
      aiAttemptReviewCreateRequestSchema.safeParse({
        attemptId: ATTEMPT_ID,
        mutationId: "m-1",
        expectedPreviewVersion: "v1-abc",
        purpose: "整体复盘",
        channel: "inapp",
      }).success,
    ).toBe(false);
    expect(
      aiAttemptReviewCreateRequestSchema.safeParse({
        attemptId: ATTEMPT_ID,
        mutationId: "m-1",
        expectedPreviewVersion: "v1-abc",
        purpose: "整体复盘",
        channel: "mcp",
        questionIds: ["q1"],
      }).success,
    ).toBe(false);
  });

  it("允许动作表：replied 只能打开/归档，cancelled 只能归档", () => {
    expect(AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS.replied).toEqual([
      "open",
      "archive",
    ]);
    expect(AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS.cancelled).toEqual(["archive"]);
    expect(AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS.failed).toEqual(["retry"]);
    expect(AI_ATTEMPT_REVIEW_MAX_QUESTIONS).toBe(30);
  });
});
