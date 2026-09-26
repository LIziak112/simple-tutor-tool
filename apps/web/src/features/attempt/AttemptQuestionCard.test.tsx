import { fireEvent, render, screen } from "@testing-library/react";
import type { QuestionPublic, StudentAnswer } from "@tutor/contract";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AttemptQuestionCard } from "./AttemptQuestionCard";

/**
 * 答题页题卡组件测试（T2.6）：题头元信息（题号/题型徽章/难度/考点）与
 * 各题型作答控件交互——判断对/错、单选、多选（可取消）、填空内联输入、
 * 手写题最终答案输入；onAnswer 的形态与防抖标记。
 *
 * 交互用有状态 Harness（answer 随 onAnswer 回写），还原真实页面的受控数据流。
 */

function baseQuestion(overrides: Partial<QuestionPublic>): QuestionPublic {
  return {
    id: "练习四-1",
    type: "judge",
    difficulty: 2,
    knowledge: ["有理数加法"],
    stemMd: "题干",
    hintCount: 0,
    ...overrides,
  };
}

/** 记录 onAnswer 调用并把答案回写给卡片（受控组件的真实行为） */
function renderStatefulCard(question: QuestionPublic) {
  const onAnswer = vi.fn();
  function Harness() {
    const [answer, setAnswer] = useState<StudentAnswer | undefined>(undefined);
    return (
      <AttemptQuestionCard
        index={2}
        question={question}
        answer={answer}
        onAnswer={(next, defer) => {
          // 与页面一致：缺省 defer 记为 false（离散控件立即保存的语义）
          onAnswer(next, defer ?? false);
          setAnswer(next);
        }}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, onAnswer };
}

describe("题头元信息", () => {
  it("渲染题号（+1）、题型徽章中文、难度星、考点 tag", () => {
    renderStatefulCard(baseQuestion({ type: "judge", difficulty: 3 }));
    expect(screen.getByText("第 3 题")).toBeInTheDocument();
    expect(screen.getByText("判断")).toBeInTheDocument();
    expect(screen.getByText("有理数加法")).toBeInTheDocument();
    expect(screen.getByLabelText("难度 3 星（满分 5 星）")).toBeInTheDocument();
  });

  it("判断题题干尾部 [[]] 替换为（　）空括号", () => {
    const { container } = renderStatefulCard(
      baseQuestion({
        type: "judge",
        stemMd: "$0$ 既不是正数，也不是负数。[[]]",
      }),
    );
    expect(container.textContent).toContain("（　）");
  });
});

describe("判断题控件", () => {
  it("点「对」提交 {kind:'judge', value:true}；选中态体现在 checked", () => {
    const { onAnswer } = renderStatefulCard(baseQuestion({ type: "judge" }));
    fireEvent.click(screen.getByRole("radio", { name: "对" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "judge", value: true },
      false,
    );
    expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
    // 切换到「错」
    fireEvent.click(screen.getByRole("radio", { name: "错" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "judge", value: false },
      false,
    );
    expect(screen.getByRole("radio", { name: "错" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "对" })).not.toBeChecked();
  });
});

describe("单选题控件", () => {
  const choice = baseQuestion({
    type: "choice",
    stemMd: "$-5$ 的相反数是（　）",
    options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
  });

  it("选项列表带字母；点选提交 {kind:'choice', index} 并回显选中", () => {
    const { onAnswer } = renderStatefulCard(choice);
    fireEvent.click(screen.getByRole("radio", { name: "选项 B" }));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "choice", index: 1 }, false);
    expect(screen.getByRole("radio", { name: "选项 B" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "选项 A" })).not.toBeChecked();
  });
});

describe("多选题控件", () => {
  const multi = baseQuestion({
    type: "multi",
    stemMd: "选出结果为正数的算式",
    options: ["$(-3)+7$", "$(-2)+(-5)$", "$0+4.8$"],
  });

  it("多选累加、再点取消；提交 {kind:'multi', indexes}", () => {
    const { onAnswer } = renderStatefulCard(multi);
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 A" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [0] },
      false,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 C" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [0, 2] },
      false,
    );
    // 再点 A → 从选中集中移除
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 A" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [2] },
      false,
    );
    expect(screen.getByRole("checkbox", { name: "选项 A" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选项 C" })).toBeChecked();
  });
});

describe("填空题：题干空位内联输入", () => {
  const fill = baseQuestion({
    type: "fill",
    stemMd: "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。",
  });

  it("空位渲染为输入框（第1空/第2空），输入触发防抖保存的 fill 答案并累计", () => {
    const { onAnswer } = renderStatefulCard(fill);
    const first = screen.getByLabelText("第1空");
    expect(first).toBeInTheDocument();
    expect(screen.getByLabelText("第2空")).toBeInTheDocument();

    fireEvent.change(first, { target: { value: "4" } });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["4"] },
      true,
    );
    // 第二空的值在第一空基础上累计（answer 已回写）
    fireEvent.change(screen.getByLabelText("第2空"), {
      target: { value: "-7" },
    });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["4", "-7"] },
      true,
    );
    // 回显
    expect(screen.getByLabelText("第1空")).toHaveValue("4");
    expect(screen.getByLabelText("第2空")).toHaveValue("-7");
  });
});

describe("手写题（solve/apply/find-error）控件", () => {
  const solve = baseQuestion({
    type: "solve",
    stemMd: "计算 $-2^2+(-3)\\times(-\\frac{1}{3})$，写出过程。",
  });

  it("显示手写区占位与最终答案输入；输入触发防抖保存并回显", () => {
    const { onAnswer } = renderStatefulCard(solve);
    expect(screen.getByText(/手写作答区即将开放/)).toBeInTheDocument();
    const input = screen.getByLabelText("最终答案");
    fireEvent.change(input, { target: { value: "-3" } });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "final", finalAnswer: "-3" },
      true,
    );
    expect(screen.getByLabelText("最终答案")).toHaveValue("-3");
  });
});
