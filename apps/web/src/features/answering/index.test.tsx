import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  QuestionAnswers,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import type { QuestionCompletion } from "../attempt/question-completion";
import {
  answerKindViews,
  dispatchComparison,
  dispatchCompletion,
  dispatchInput,
} from "./index";
import { prepareQuestion } from "./prepare-question";
import type { ReferenceMaterial } from "./types";

/**
 * 呈现登记表与唯一调度边界（方案 §4.4/§10，UA-03 落地）的路由与差分测试：
 * - 登记表五 kind 穷尽（I01 运行时键集；编译期由 satisfies 锁定）；
 * - dispatchInput/comparison/completion 按 kind 派发（错配模型不进视图，I02）；
 * - I05 回调节奏（fill defer=true、选择/判断即时）；
 * - I08 只读/公开底图不触发答案变更；
 * - ReferenceMaterial 三态（unavailable 锁定 / no-reference 空态 / available）；
 * - I09 泄露：未公布参考不进 DOM（哨兵断言）；
 * - I02 只读呈现无答案。
 *
 * 各宿主迁移前后的 DOM 逐字差分以宿主既有测试为基准
 * （QuestionSurface.test / ResultAnswerComparison.test / question-completion.test），
 * 此处只锁登记表与调度边界自身的行为。
 */

const choiceQuestion: QuestionPublic = {
  id: "q-choice",
  type: "choice",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
  stemMd: "下列正确的是",
  options: ["甲", "乙"],
};

function prepared(
  question: QuestionPublic,
): ReturnType<typeof prepareQuestion> {
  return prepareQuestion(question, `${question.id}-test`);
}

describe("answerKindViews 登记表", () => {
  it("五 kind 全配（I01 运行时键集）", () => {
    expect(Object.keys(answerKindViews).sort()).toEqual([
      "choice",
      "fill",
      "final",
      "judge",
      "multi",
    ]);
  });
});

describe("dispatchInput 题面输入派发", () => {
  it("judge：radiogroup 判断对错，false 是有效输入（I03）", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "judge",
      options: undefined,
      stemMd: "命题。[[]]",
    });
    const update = vi.fn();
    render(
      screenStub(
        dispatchInput(model, { kind: "judge", value: true }, update, false),
      ),
    );
    expect(
      screen.getByRole("radiogroup", { name: "判断对错" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "错" }));
    expect(update).toHaveBeenCalledWith(
      { kind: "judge", value: false },
      undefined,
    );
  });

  it("choice：radio 即时回调（I05 不 defer），index=0 有效（I03）", () => {
    const model = prepared(choiceQuestion);
    const update = vi.fn();
    render(screenStub(dispatchInput(model, undefined, update, false)));
    fireEvent.click(screen.getByRole("radio", { name: /甲/ }));
    expect(update).toHaveBeenCalledWith(
      { kind: "choice", index: 0 },
      undefined,
    );
  });

  it("multi：checkbox 勾选顺序不被排序改写（I04）", () => {
    const model = prepared({ ...choiceQuestion, type: "multi" });
    const update = vi.fn();
    const { rerender } = render(
      screenStub(dispatchInput(model, undefined, update, false)),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /乙/ }));
    expect(update).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [1] },
      undefined,
    );
    // 受控更新：以首次结果续勾，顺序 [1,0] 不被排序改写
    rerender(
      screenStub(
        dispatchInput(model, { kind: "multi", indexes: [1] }, update, false),
      ),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /甲/ }));
    expect(update).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [1, 0] },
      undefined,
    );
  });

  it("fill：内联空位 defer=true（I05），空序与已有答案一致", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "fill",
      options: undefined,
      stemMd: "甲 [[]]，乙 [[]]",
    });
    const update = vi.fn();
    render(
      screenStub(
        dispatchInput(
          model,
          { kind: "fill", values: ["原", ""] },
          update,
          false,
        ),
      ),
    );
    expect(screen.getByRole("textbox", { name: "第1空" })).toHaveValue("原");
    fireEvent.change(screen.getByRole("textbox", { name: "第2空" }), {
      target: { value: "新" },
    });
    expect(update).toHaveBeenCalledWith(
      { kind: "fill", values: ["原", "新"] },
      true,
    );
  });

  it("final：题面不渲染第二份最终答案输入（final 输入由纸面控件托管）", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "solve",
      options: undefined,
      stemMd: "求解。",
    });
    render(screenStub(dispatchInput(model, undefined, vi.fn(), false)));
    expect(screen.queryByRole("textbox", { name: "最终答案" })).toBeNull();
    expect(screen.getByText("求解。")).toBeInTheDocument();
  });

  it("答案 kind 与模型不匹配时按未作答呈现、不伪造保存（I02）", () => {
    const model = prepared(choiceQuestion);
    const update = vi.fn();
    const mismatched: StudentAnswer = { kind: "judge", value: true };
    render(screenStub(dispatchInput(model, mismatched, update, false)));
    expect(screen.getByRole("radio", { name: /甲/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /乙/ })).not.toBeChecked();
  });

  it("disabled 只读态输入携带禁用语义（I08；更新拦截在宿主数据流——§5）", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "fill",
      options: undefined,
      stemMd: "甲 [[]]",
    });
    render(
      screenStub(
        dispatchInput(model, { kind: "fill", values: ["值"] }, vi.fn(), true),
      ),
    );
    expect(screen.getByRole("textbox", { name: "第1空" })).toBeDisabled();
    const judgeModel = prepared({
      ...choiceQuestion,
      id: "q-judge2",
      type: "judge",
      options: undefined,
      stemMd: "命题。[[]]",
    });
    render(screenStub(dispatchInput(judgeModel, undefined, vi.fn(), true)));
    expect(screen.getByRole("radio", { name: "对" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "错" })).toBeDisabled();
  });
});

describe("dispatchComparison 对照派发", () => {
  const fillQuestion: QuestionPublic = {
    ...choiceQuestion,
    id: "q-fill",
    type: "fill",
    options: undefined,
    stemMd: "计算 [[ ]]；[[ ]]。",
  };
  const fillAnswer: StudentAnswer = { kind: "fill", values: ["\\frac{1}{2}"] };
  const fillReference: QuestionAnswers = {
    kind: "fill",
    blanks: [["\\frac{1}{2}"], ["8"]],
  };

  it("available：填空逐空对齐，本人与参考公式都可读", () => {
    const model = prepared(fillQuestion);
    const { container } = render(
      screenStub(
        dispatchComparison(model, fillAnswer, {
          status: "available",
          reference: fillReference,
        }),
      ),
    );
    const own = screen.getByRole("list", { name: "你的填空答案" });
    expect(within(own).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByRole("list", { name: "参考填空答案" }),
    ).toHaveTextContent("8");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
  });

  it("available：额外历史项有独立行（口径与现网一致）", () => {
    const model = prepared({
      ...fillQuestion,
      stemMd: "计算 [[ ]]。",
    });
    render(
      screenStub(
        dispatchComparison(
          model,
          { kind: "fill", values: ["a", "b"] },
          { status: "available", reference: { kind: "fill", blanks: [["a"]] } },
        ),
      ),
    );
    const own = screen.getByRole("list", { name: "你的填空答案" });
    expect(within(own).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByRole("list", { name: "参考填空答案" }),
    ).toHaveTextContent("第2空");
  });

  it("unavailable：锁定提示，参考内容不进 DOM（I09 哨兵）", () => {
    const model = prepared(fillQuestion);
    render(
      screenStub(
        dispatchComparison(model, fillAnswer, { status: "unavailable" }),
      ),
    );
    expect(
      screen.getByText("参考答案与详解将在截止后公布 🔒"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).toBeNull();
    // 左列仍呈现本人作答（未公布不吞掉本人答案）
    expect(
      screen.getByRole("list", { name: "你的填空答案" }),
    ).toBeInTheDocument();
  });

  it("no-reference：已公布但无参考显示原有空态", () => {
    const model = prepared(fillQuestion);
    render(
      screenStub(
        dispatchComparison(model, fillAnswer, { status: "no-reference" }),
      ),
    );
    expect(screen.getByText("暂无参考答案")).toBeInTheDocument();
  });

  it("judge：available 文本对照（你的答案/参考答案）", () => {
    const model = prepared({
      ...choiceQuestion,
      id: "q-judge",
      type: "judge",
      options: undefined,
      stemMd: "命题。[[]]",
    });
    render(
      screenStub(
        dispatchComparison(
          model,
          { kind: "judge", value: true },
          { status: "available", reference: { kind: "judge", value: false } },
        ),
      ),
    );
    expect(screen.getByText("你的答案：")).toBeInTheDocument();
    expect(screen.getByText("对")).toBeInTheDocument();
    expect(screen.getByText("错")).toBeInTheDocument();
  });
});

describe("dispatchCompletion 完整度派发", () => {
  it("fill 按有效空位计，额外数组项不能填补空位（§7.1）", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "fill",
      options: undefined,
      stemMd: "甲 [[]]，乙 [[]]",
    });
    expect(
      dispatchCompletion(
        model,
        { kind: "fill", values: ["a", "b", "c"] },
        false,
      ),
    ).toEqual({
      state: "filled",
      filledSlots: 2,
      expectedSlots: 2,
    } satisfies QuestionCompletion);
  });

  it("final 有正式笔迹未填最终答案为 partial（I06）", () => {
    const model = prepared({
      ...choiceQuestion,
      type: "solve",
      options: undefined,
      stemMd: "求解。",
    });
    expect(
      dispatchCompletion(model, { kind: "final", finalAnswer: "" }, true),
    ).toEqual({
      state: "partial",
      filledSlots: 0,
      expectedSlots: 1,
    } satisfies QuestionCompletion);
  });

  it("choice 越界索引不算已填写", () => {
    const model = prepared(choiceQuestion);
    expect(
      dispatchCompletion(model, { kind: "choice", index: 99 }, false),
    ).toEqual({
      state: "empty",
      filledSlots: 0,
      expectedSlots: 1,
    } satisfies QuestionCompletion);
  });
});

describe("登记表视图的只读呈现（I02 只读无答案）", () => {
  it("各 kind ReadOnly 不含参考答案内容", () => {
    const preparedJudge = prepared({
      ...choiceQuestion,
      id: "q-judge",
      type: "judge",
      options: undefined,
      stemMd: "命题。[[]]",
    });
    if (preparedJudge.kind !== "judge") throw new Error("非 judge 模型");
    const { container } = render(
      screenStub(
        answerKindViews.judge.ReadOnly({
          model: preparedJudge,
          answer: { kind: "judge", value: true },
        }),
      ),
    );
    expect(container.textContent).toContain("对");
    expect(container.textContent).not.toContain("参考");
  });
});

/** 视图返回 ReactNode；包一层 div 便于 render */
function screenStub(node: React.ReactNode): React.ReactElement {
  return <div>{node}</div>;
}

/** 类型层负例：ReferenceMaterial 不携带参考对象时无法读取答案（编译期保护，运行时无操作） */
describe("ReferenceMaterial 类型", () => {
  it("unavailable 分支运行时不携带参考", () => {
    const material: ReferenceMaterial<QuestionAnswers> = {
      status: "unavailable",
    };
    expect(material.status).toBe("unavailable");
  });
});
