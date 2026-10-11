import { fireEvent, render, screen } from "@testing-library/react";
import type { AttemptResultQuestion } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { ResultQuestionNavigator } from "./ResultQuestionNavigator";

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
  answer: null,
  answers: null,
  autoCorrect: false,
  finalCorrect: false,
  teacherMark: null,
  teacherComment: null,
  solutionMd: null,
  hintsOpened: [],
};
it("回看题号沿原卷编号，未作答与判错并存且能定位末题", () => {
  const jump = vi.fn();
  render(
    <ResultQuestionNavigator
      questions={[question, { ...question, questionId: "q2" }]}
      released
      scope="unanswered"
      currentId="q1"
      onJump={jump}
    />,
  );
  const last = screen.getByRole("button", { name: "第 2 题，未作答，判错" });
  fireEvent.click(last);
  expect(jump).toHaveBeenCalledWith("q2");
  expect(
    screen.getByRole("button", { name: "第 1 题，未作答，判错" }),
  ).toHaveAttribute("aria-current", "location");
});
it("未公布不暴露判定；空定位范围有退出入口", () => {
  const { rerender } = render(
    <ResultQuestionNavigator
      questions={[question]}
      released={false}
      scope="all"
      currentId="q1"
      onJump={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "第 1 题，未作答" }),
  ).toBeInTheDocument();
  rerender(
    <ResultQuestionNavigator
      questions={[question]}
      released
      scope="pending"
      currentId="q1"
      onJump={vi.fn()}
    />,
  );
  expect(screen.getByText("此范围没有题目")).toBeInTheDocument();
});
