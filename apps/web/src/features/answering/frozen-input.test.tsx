import { fireEvent, render, screen } from "@testing-library/react";
import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { useState } from "react";
import { expect, it } from "vitest";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";

const question: QuestionPublic = {
  id: "q",
  type: "fill",
  stemMd: "甲 [[]]，乙 [[]]",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};
it("普通填空只有原生题内控件，答案和只读仍由唯一宿主管理", () => {
  function Host({ readOnly = false }: { readOnly?: boolean }) {
    const [answer, setAnswer] = useState<StudentAnswer>();
    return (
      <QuestionSurface
        question={question}
        answer={answer}
        onAnswer={setAnswer}
        readOnly={readOnly}
      />
    );
  }
  const { container, rerender } = render(<Host />);
  const first = screen.getByRole("textbox", { name: "第1空" });
  fireEvent.change(first, { target: { value: "中文2x" } });
  expect(first).toHaveValue("中文2x");
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  expect(container.querySelector('[data-slot="frozen-control"]')).toBeNull();
  rerender(<Host readOnly />);
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(first);
  expect(first).toHaveValue("中文2x");
  expect(first).toBeDisabled();
});
