import type { AttemptResultQuestion } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  reviewCounts,
  reviewQuestionState,
  reviewScopes,
} from "./result-review-model";

const question: AttemptResultQuestion = {
  questionId: "q1",
  snapshot: {
    id: "q1",
    type: "judge",
    difficulty: 1,
    knowledge: [],
    stemMd: "判断",
    hintCount: 0,
  },
  answer: { kind: "judge", value: false },
  answers: { kind: "judge", value: false },
  autoCorrect: true,
  finalCorrect: false,
  teacherMark: "wrong",
  teacherComment: "注意条件",
  solutionMd: null,
  hintsOpened: [],
};

describe("回看展示模型", () => {
  it("教师清除判定后回到待批，不能用旧自动判分覆盖finalCorrect=null", () => {
    expect(
      reviewQuestionState(
        { ...question, finalCorrect: null, teacherMark: null },
        true,
      ).verdict,
    ).toBeNull();
  });
  it("教师最终判定优先，判断false仍是作答，未答与判错独立", () => {
    expect(reviewQuestionState(question, true)).toEqual({
      verdict: false,
      unanswered: false,
    });
    const empty = { ...question, answer: null };
    expect(reviewQuestionState(empty, true)).toEqual({
      verdict: false,
      unanswered: true,
    });
    expect(reviewCounts([question, empty], true)).toEqual({
      correct: 0,
      wrong: 2,
      pending: 0,
      unanswered: 1,
    });
  });
  it("未公布不能从已有判定推导隐含对错或待批筛选", () => {
    expect(reviewQuestionState(question, false)).toEqual({
      verdict: null,
      unanswered: false,
    });
    expect(reviewCounts([question], false)).toEqual({
      correct: 0,
      wrong: 0,
      pending: 0,
      unanswered: 0,
    });
    expect(reviewScopes(false)).toEqual(["all", "unanswered"]);
    expect(reviewScopes(true)).toEqual([
      "all",
      "wrong",
      "unanswered",
      "pending",
    ]);
  });

  // ---------- QM-12（TT-09c）：有效判定口径（教师判 > 自评 > 自动） ----------

  const selfRow = (
    overrides: Partial<AttemptResultQuestion> = {},
  ): AttemptResultQuestion => ({
    ...question,
    // reference_self 行 autoCorrect/finalCorrect 恒 null（TT-09a 判分口径）
    autoCorrect: null,
    finalCorrect: null,
    teacherMark: null,
    teacherComment: null,
    gradingPolicy: "reference_self",
    ...overrides,
  });
  const selfRecord = (verdict: "correct" | "wrong") => ({
    record: {
      verdict,
      at: "2026-10-24T00:00:00.000Z",
      revision: 1,
    },
    revision: 1,
  });

  it("reference_self 行按自评三态计对/错/待判断（与逐题徽章同口径）", () => {
    expect(
      reviewQuestionState(selfRow({ selfReview: selfRecord("correct") }), true),
    ).toEqual({
      verdict: true,
      unanswered: false,
    });
    expect(
      reviewQuestionState(selfRow({ selfReview: selfRecord("wrong") }), true),
    ).toEqual({
      verdict: false,
      unanswered: false,
    });
    // 未自评/已撤回（record=null）→ 待判断（不冒充客观判定）
    expect(
      reviewQuestionState(
        selfRow({ selfReview: { record: null, revision: 2 } }),
        true,
      ),
    ).toEqual({
      verdict: null,
      unanswered: false,
    });
    expect(
      reviewCounts(
        [
          selfRow({ selfReview: selfRecord("correct") }),
          selfRow({ selfReview: selfRecord("wrong") }),
          selfRow({ selfReview: { record: null, revision: 0 } }),
        ],
        true,
      ),
    ).toEqual({ correct: 1, wrong: 1, pending: 1, unanswered: 0 });
  });

  it("教师判优先于自评（改判/清除回落），非自评行不受 selfReview 影响", () => {
    // 教师已判：自评保留但以教师为准——markResponse D3 口径同步写
    // finalCorrect（教师已判行走 finalCorrect 徽章路径，改判立即生效）
    expect(
      reviewQuestionState(
        selfRow({
          selfReview: selfRecord("wrong"),
          teacherMark: "correct",
          finalCorrect: true,
        }),
        true,
      ).verdict,
    ).toBe(true);
    // 教师清除回落自评（mark=null → finalCorrect 回落 autoCorrect，而
    // reference_self 行 autoCorrect 恒 null——非清到自动）
    expect(
      reviewQuestionState(
        selfRow({ selfReview: selfRecord("correct"), teacherMark: null }),
        true,
      ).verdict,
    ).toBe(true);
    // 非 reference_self 行沿既有 finalCorrect 路径，脏 selfReview 不改变判定
    expect(
      reviewQuestionState(
        { ...question, selfReview: selfRecord("correct") },
        true,
      ).verdict,
    ).toBe(false);
  });

  it("未公布时自评键整键 null 投影——不得从 gradingPolicy 推出待自评数", () => {
    expect(
      reviewCounts([selfRow({ selfReview: selfRecord("wrong") })], false),
    ).toEqual({ correct: 0, wrong: 0, pending: 0, unanswered: 0 });
  });
});
