import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { dispatchFrozenInput } from "./index";

const question: AttemptQuestionPublic = {
  id: "q-fill",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "fill",
  stemMd: "求 $f'(x)$，先填 [[]]，再填 [[]]。",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 3,
  questionRevisionId: question.questionRevisionId,
  cssWidth: 600,
  cssHeight: 300,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  controls: [
    { slotId: "slot-1", kind: "text", x: 80, y: 40, width: 112, height: 44 },
    { slotId: "slot-2", kind: "text", x: 310, y: 150, width: 112, height: 44 },
  ],
};

describe("冻结原稿填空入口", () => {
  it("沿用唯一答案更新通道、保存的槽位坐标和现有 BlankDirective", () => {
    const update = vi.fn();
    function Host() {
      const [answer, setAnswer] = useState<StudentAnswer | undefined>();
      return dispatchFrozenInput(
        question,
        layout,
        answer,
        (next, defer) => {
          update(next, defer);
          setAnswer(next);
        },
        false,
      );
    }
    const { container } = render(<Host />);
    const first = screen.getByRole("textbox", { name: "第1空" });
    const second = screen.getByRole("textbox", { name: "第2空" });
    expect(
      container.querySelectorAll('input[data-testid^="blank-"]'),
    ).toHaveLength(2);
    expect(first.closest('[data-slot="frozen-control"]')).toHaveStyle({
      left: "80px",
      top: "40px",
      width: "112px",
      height: "44px",
    });
    fireEvent.change(first, { target: { value: "2x" } });
    expect(update).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["2x"] },
      true,
    );
    expect(first).toHaveValue("2x");
    fireEvent.change(second, { target: { value: "3x" } });
    expect(update).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["2x", "3x"] },
      true,
    );
  });

  it("笔态和只读时保留已填值，但输入无法改写", () => {
    const update = vi.fn();
    render(
      dispatchFrozenInput(
        question,
        layout,
        { kind: "fill", values: ["保留"] },
        update,
        true,
      ),
    );
    const first = screen.getByRole("textbox", { name: "第1空" });
    expect(first).toHaveValue("保留");
    expect(first).toBeDisabled();
    fireEvent.change(first, { target: { value: "越权" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("题目 revision 或槽位键不符时不猜测旧坐标", () => {
    const update = vi.fn();
    expect(
      dispatchFrozenInput(
        question,
        {
          ...layout,
          questionRevisionId: "22222222-2222-4222-8222-222222222222",
        },
        undefined,
        update,
        false,
      ),
    ).toBeNull();
    if (layout.renderVersion !== 3) throw new Error("测试需要 v3");
    const first = layout.controls[0];
    const second = layout.controls[1];
    if (!first || !second) throw new Error("测试缺少两个填空槽位");
    expect(
      dispatchFrozenInput(
        question,
        {
          ...layout,
          controls: [{ ...first, slotId: "other" }, second],
        },
        undefined,
        update,
        false,
      ),
    ).toBeNull();
    expect(
      dispatchFrozenInput(
        question,
        {
          ...layout,
          controls: [first],
        },
        undefined,
        update,
        false,
      ),
    ).toBeNull();
  });
});
