import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubmitConfirmDialog } from "./SubmitConfirmDialog";

/** 交卷确认弹层测试（T2.6）：未答数量提示与确认/继续作答回调。 */

describe("SubmitConfirmDialog", () => {
  it("有未答题时显示具体数量并警示不能再修改", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={3}
        submitting={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("确认交卷吗？")).toBeInTheDocument();
    expect(
      screen.getByText("还有 3 题没有作答，交卷后不能再修改答案。"),
    ).toBeInTheDocument();
  });

  it("全部作答时提示全部已作答；确认与继续作答按钮各自触发回调", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(
      screen.getByText("全部题目已作答，交卷后立即判分且不能再修改答案。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "继续作答" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("提交中两个按钮都禁用（防重复交卷）", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "正在交卷…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "继续作答" })).toBeDisabled();
  });
});
