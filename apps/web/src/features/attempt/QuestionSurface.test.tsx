import { fireEvent, render, screen } from "@testing-library/react";
import type { QuestionPublic } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { QuestionSurface } from "./QuestionSurface";

const question: QuestionPublic = {
  id: "surface",
  type: "choice",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
  stemMd: "计算 $1+2$。",
  options: ["3", "4"],
};

describe("共享题面", () => {
  it("正常模式保留原生作答及选中状态", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={question}
        answer={{ kind: "choice", index: 1 }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByRole("radio", { name: "选项 B" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "选项 A" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "choice", index: 0 },
      undefined,
    );
  });

  it("导出不携带本人选中态，不触发作答回调", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={question}
        answer={{ kind: "choice", index: 1 }}
        onAnswer={onAnswer}
        mode="export"
      />,
    );
    expect(screen.getByRole("radio", { name: "选项 B" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "选项 A" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("导出保留同尺寸填空输入框但清空个人值", () => {
    render(
      <QuestionSurface
        question={{ ...question, type: "fill", stemMd: "甲 [[]]，乙 [[]]。" }}
        answer={{ kind: "fill", values: ["私人答案", "5"] }}
        mode="export"
      />,
    );
    expect(screen.getByLabelText("第1空")).toHaveValue("");
    expect(screen.getByLabelText("第2空")).toHaveValue("");
  });
});
