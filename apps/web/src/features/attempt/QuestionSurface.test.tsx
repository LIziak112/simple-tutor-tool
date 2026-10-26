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
  it.each(["choice", "multi"] as const)(
    "%s 的独立数字句点选项按正文显示，真实列表仍保留",
    (type) => {
      const { container } = render(
        <QuestionSurface
          question={{
            ...question,
            type,
            options: ["0.", "1.", "2.", "3.", "1. 第一条\n2. 第二条"],
          }}
        />,
      );
      const labels = [...container.querySelectorAll("label")];
      for (const [index, label] of labels.slice(0, 4).entries()) {
        expect(label).toHaveTextContent(`${index}.`);
        expect(label.querySelector("ol")).toBeNull();
      }
      expect(labels[4]?.querySelectorAll("ol > li")).toHaveLength(2);
    },
  );

  it("相同作答属性重渲染时保持原生选择控件静止，更新回调后使用最新操作", () => {
    const onAnswer = vi.fn();
    const judge = { ...question, type: "judge" as const };
    const { container, rerender } = render(
      <QuestionSurface question={judge} onAnswer={onAnswer} />,
    );
    const observer = new MutationObserver(() => {});
    observer.observe(container, { attributes: true, subtree: true });
    rerender(<QuestionSurface question={judge} onAnswer={onAnswer} />);
    const updates = observer.takeRecords();
    observer.disconnect();
    expect(updates).toHaveLength(0);
    const current = vi.fn();
    rerender(<QuestionSurface question={judge} onAnswer={current} />);
    fireEvent.click(screen.getByRole("radio", { name: /^对$/ }));
    expect(current).toHaveBeenCalledWith(
      { kind: "judge", value: true },
      undefined,
    );
    expect(onAnswer).toHaveBeenCalledTimes(0);
  });
  it("题面宽度由所在列决定，不另设固定最大宽度", () => {
    const { container } = render(<QuestionSurface question={question} />);
    const surface = container.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    expect(surface).toHaveClass("w-full", "min-w-0");
    expect(surface?.style.maxWidth).toBe("");
  });

  it("内联填空沿用空位顺序与已有答案", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionSurface
        question={{ ...question, type: "fill", stemMd: "甲 [[]]，乙 [[]]" }}
        answer={{ kind: "fill", values: ["原答案", ""] }}
        onAnswer={onAnswer}
      />,
    );
    expect(
      document.querySelector('[data-slot="question-surface"]'),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "第1空" })).toHaveValue(
      "原答案",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "第2空" }), {
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

  it("单选重复选项文本不再产生 key 冲突告警，渲染与选中语义不变（§4.2/§13.2）", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onAnswer = vi.fn();
    const { unmount } = render(
      <QuestionSurface
        question={{
          ...question,
          options: ["相同选项", "相同选项", "不同选项"],
        }}
        onAnswer={onAnswer}
      />,
    );
    // 重复文本选项逐项渲染，字母按序区分（DOM/class/可访问名称不变）
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    const [first, second] = radios;
    if (first === undefined || second === undefined) {
      throw new Error("重复选项应逐项渲染三个 radio");
    }
    expect(first).toHaveAccessibleName("选项 A 相同选项");
    expect(second).toHaveAccessibleName("选项 B 相同选项");
    expect(first.className).toBe(second.className);
    // 选中语义按索引区分（I04：索引不被归一化）
    fireEvent.click(screen.getByRole("radio", { name: "选项 B 相同选项" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "choice", index: 1 },
      undefined,
    );
    const keyWarnings = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("same key"));
    expect(keyWarnings).toHaveLength(0);
    errorSpy.mockRestore();
    unmount();
  });

  it("多选重复选项文本同样无 key 冲突告警，勾选按索引区分", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onAnswer = vi.fn();
    const { unmount } = render(
      <QuestionSurface
        question={{
          ...question,
          type: "multi",
          options: ["相同选项", "相同选项"],
        }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 B 相同选项" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "multi", indexes: [1] },
      undefined,
    );
    const keyWarnings = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("same key"));
    expect(keyWarnings).toHaveLength(0);
    errorSpy.mockRestore();
    unmount();
  });
});
