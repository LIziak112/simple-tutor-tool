import { render, screen, within } from "@testing-library/react";
import type { AttemptResultQuestion } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { QuestionFeedback } from "./QuestionFeedback";
import {
  practiceFeedbackRestrictedCopy,
  practiceUnreadableFeedbackCopy,
} from "./practice-protocol";
import type { PracticeWorkflow } from "@tutor/contract";

/**
 * 题级反馈区（M3-D2，§10.4 授权投影四态）：released 简短结论 + 本人/参考
 * 答案对照 + 解析默认展开（无解析明确文案）；pending_attempt / restricted
 * 按原因给文案；not_submitted 不渲染。文案函数与 practice-protocol 单源。
 */

const releasedQuestion = (overrides: Partial<AttemptResultQuestion> = {}) =>
  ({
    questionId: "q1",
    snapshot: {
      id: "q1",
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数"],
      stemMd: "$0$ 既不是正数，也不是负数。[[]]",
      hintCount: 0,
    },
    answers: { kind: "judge", value: true },
    solutionMd: "0 不是正数也不是负数，所以说法正确。",
    answer: { kind: "judge", value: true },
    autoCorrect: true,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: true,
    hintsOpened: [],
    ...overrides,
  }) as AttemptResultQuestion;

describe("QuestionFeedback", () => {
  it("released 正确题：结论徽章 + 本人/参考答案对照 + 解析默认展开", () => {
    render(
      <QuestionFeedback
        feedback={{ status: "released", question: releasedQuestion() }}
      />,
    );
    const area = screen.getByRole("region", { name: "本题反馈" });
    expect(within(area).getByText("回答正确")).toBeInTheDocument();
    expect(within(area).getByText("你的答案：")).toBeInTheDocument();
    expect(within(area).getByText("参考答案：")).toBeInTheDocument();
    expect(within(area).getByText("解析")).toBeInTheDocument();
    expect(
      within(area).getByText(/0 不是正数也不是负数/),
    ).toBeInTheDocument();
    // 解析默认展开：不提供「查看详解」折叠入口
    expect(
      screen.queryByRole("button", { name: /查看详解/ }),
    ).toBeNull();
  });

  it("released 错误题：结论为回答有误", () => {
    render(
      <QuestionFeedback
        feedback={{
          status: "released",
          question: releasedQuestion({ finalCorrect: false }),
        }}
      />,
    );
    expect(screen.getByText("回答有误")).toBeInTheDocument();
  });

  it("released 待批题（finalCorrect=null）：待老师批改文案，不出现对错", () => {
    render(
      <QuestionFeedback
        feedback={{
          status: "released",
          question: releasedQuestion({ finalCorrect: null }),
        }}
      />,
    );
    expect(screen.getByText("已提交，待老师批改")).toBeInTheDocument();
    expect(screen.queryByText(/回答正确|回答有误/)).toBeNull();
  });

  it("released 无解析：明确「本题暂无解析」，不造空白折叠卡", () => {
    render(
      <QuestionFeedback
        feedback={{
          status: "released",
          question: releasedQuestion({ solutionMd: null }),
        }}
      />,
    );
    expect(screen.getByText("本题暂无解析")).toBeInTheDocument();
    expect(screen.queryByText("解析")).toBeNull();
  });

  it("pending_attempt：交卷后统一公布文案，无任何题目内容", () => {
    render(<QuestionFeedback feedback={{ status: "pending_attempt" }} />);
    expect(
      screen.getByText("已提交，交卷后统一公布"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/你的答案|参考答案|解析/)).toBeNull();
  });

  it("restricted 三原因文案（practice-protocol 单源）", () => {
    expect(
      practiceFeedbackRestrictedCopy("teacher_after_attempt"),
    ).toBe("老师要求交卷后公布");
    expect(practiceFeedbackRestrictedCopy("teacher_after_due")).toBe(
      "老师要求截止后公布",
    );
    expect(practiceFeedbackRestrictedCopy("legacy_attempt")).toBe(
      "本练习不支持逐题反馈",
    );
    render(
      <QuestionFeedback
        feedback={{
          status: "restricted",
          restrictionReason: "teacher_after_due",
        }}
      />,
    );
    expect(screen.getByText("老师要求截止后公布")).toBeInTheDocument();
  });

  it("not_submitted：不渲染反馈区", () => {
    const { container } = render(
      <QuestionFeedback feedback={{ status: "not_submitted" }} />,
    );
    expect(container.querySelector('[data-slot="practice-question-feedback"]'))
      .toBeNull();
    expect(screen.queryByRole("region", { name: "本题反馈" })).toBeNull();
  });

  it("不可读行的本地文案：受限按原因，否则按统一公布（不额外发请求时也能呈现）", () => {
    const workflow = (over: Partial<PracticeWorkflow>): PracticeWorkflow => ({
      version: 1,
      feedbackMode: "per_question",
      revision: 0,
      canChangeFeedback: true,
      allowedFeedbackModes: ["per_question", "after_attempt"],
      canSubmitQuestion: true,
      restrictionReason: null,
      releaseAt: null,
      ...over,
    });
    expect(
      practiceUnreadableFeedbackCopy(
        workflow({ canSubmitQuestion: false, restrictionReason: "teacher_after_attempt" }),
      ),
    ).toBe("老师要求交卷后公布");
    expect(
      practiceUnreadableFeedbackCopy(workflow({ feedbackMode: "after_attempt" })),
    ).toBe("已提交，交卷后统一公布");
  });
});
