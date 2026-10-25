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
  answered: true,
  studentFlag: null,
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
});
