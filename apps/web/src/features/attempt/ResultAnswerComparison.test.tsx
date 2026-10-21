import { render, screen, within } from "@testing-library/react";
import type { AttemptResultQuestion } from "@tutor/contract";
import { expect, it } from "vitest";
import { ResultAnswerComparison } from "./ResultAnswerComparison";

const question: Pick<AttemptResultQuestion, "snapshot" | "answer" | "answers"> =
  {
    snapshot: {
      id: "fill",
      type: "fill",
      difficulty: 1,
      knowledge: [],
      stemMd: "计算 [[ ]]；[[ ]]。",
      hintCount: 0,
    },
    answer: { kind: "fill", values: ["\\frac{1}{2}"] },
    answers: { kind: "fill", blanks: [["\\frac{1}{2}"], ["8"]] },
  };

it("填空按空号对照，缺项明确未填，本人和参考公式都可读", () => {
  const { container } = render(
    <ResultAnswerComparison question={question} released />,
  );
  const own = screen.getByRole("list", { name: "你的填空答案" });
  expect(within(own).getAllByRole("listitem")).toHaveLength(2);
  expect(own).toHaveTextContent("第2空未填");
  expect(container.querySelectorAll(".katex")).toHaveLength(2);
  expect(screen.getByRole("list", { name: "参考填空答案" })).toHaveTextContent(
    "8",
  );
});

it("公布前不读取参考答案空数或内容，温和展示截止后公布提示", () => {
  render(
    <ResultAnswerComparison
      question={{
        ...question,
        answers: { kind: "fill", blanks: [["secret"], ["8"], ["secret"]] },
      }}
      released={false}
    />,
  );
  expect(screen.queryByRole("list", { name: "参考填空答案" })).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(
    screen.getByText("参考答案与详解将在截止后公布 🔒"),
  ).toBeInTheDocument();
});
