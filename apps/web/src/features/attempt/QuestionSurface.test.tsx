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
  it("历史底图的独立填空控件沿用题面空位顺序与已有答案，不重复题干", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={{ ...question, type: "fill", stemMd: "甲 [[]]，乙 [[]]" }}
        answer={{ kind: "fill", values: ["原答案", ""] }}
        onAnswer={onAnswer}
        answerOnly
      />,
    );
    expect(screen.queryByText("甲")).toBeNull();
    expect(screen.getByRole("textbox", { name: "第 1 空" })).toHaveValue(
      "原答案",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "第 2 空" }), {
      target: { value: "新答案" },
    });
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "fill", values: ["原答案", "新答案"] },
      true,
    );
  });
  it("单选控件名称包含字母和实际选项内容", () => {
    render(
      <QuestionSurface
        question={{ ...question, options: ["系统调用", "中断"] }}
      />,
    );
    expect(screen.getAllByRole("radio")[0]).toHaveAccessibleName(
      "选项 A 系统调用",
    );
    expect(screen.getAllByRole("radio")[1]).toHaveAccessibleName("选项 B 中断");
  });

  it("多选控件名称包含正文，选择行为仍由原生标签触发", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={{ ...question, type: "multi", options: ["进程", "设备"] }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getAllByRole("checkbox")[1]).toHaveAccessibleName(
      "选项 B 设备",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 B 设备" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "multi", indexes: [1] },
      undefined,
    );
  });

  it("同一道题的正常与导出实例隔离radio组", () => {
    const { container } = render(
      <>
        <QuestionSurface question={question} />
        <QuestionSurface question={question} mode="export" />
      </>,
    );
    const groups = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].map((input) => input.name);
    expect(groups[0]).not.toBe(groups[2]);
  });
  it("判断图标预留尺寸，不随选中态增加元素", () => {
    const { container, rerender } = render(
      <QuestionSurface question={{ ...question, type: "judge" }} />,
    );
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    rerender(
      <QuestionSurface
        question={{ ...question, type: "judge" }}
        answer={{ kind: "judge", value: true }}
      />,
    );
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });
  it("正常模式保留原生作答及选中状态", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={question}
        answer={{ kind: "choice", index: 1 }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByRole("radio", { name: /^选项 B/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /^选项 A/ }));
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
    expect(screen.getByRole("radio", { name: /^选项 B/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /^选项 A/ }));
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
