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

  it("T6R.10 草稿状态区：已同步待固定/未保存完整/未写计数如实展示", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        noteSummary={{ willFreeze: 2, problem: 1, unwritten: 5 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 题草稿已同步/)).toBeInTheDocument();
    expect(screen.getByText(/1 题草稿未保存完整/)).toBeInTheDocument();
    expect(screen.getByText(/其余 5 题未写草稿/)).toBeInTheDocument();
  });

  it("T6R.10 有未保存草稿时进入明确选择分支：列问题、只有缺稿确认与继续作答两个出口", () => {
    const onConfirm = vi.fn();
    const onConfirmMissing = vi.fn();
    const onCancel = vi.fn();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        noteProblems={[
          { index: 3, reason: "草稿尚未保存完整（网络不稳定，正在重试）" },
        ]}
        choiceMode
        onConfirm={onConfirm}
        onConfirmMissing={onConfirmMissing}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/第 3 题/)).toBeInTheDocument();
    expect(
      screen.getByText(/草稿尚未保存完整（网络不稳定，正在重试）/),
    ).toBeInTheDocument();
    // 普通确认按钮不存在——缺稿交卷必须走明确选择
    expect(
      screen.queryByRole("button", { name: "确认交卷" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /提交答案，草稿未保存完整/ }),
    );
    expect(onConfirmMissing).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "继续作答" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("T6R.10 准备中（追平草稿/组装声明）：显示同步文案且按钮禁用", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        preparing
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/正在同步草稿/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续作答" })).toBeDisabled();
  });

  it("T6R.10 error 相携带最近一次 problems：清单与错误文案都可见，确认键为普通重试", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        noteProblems={[
          { index: 2, reason: "草稿尚未保存完整（网络不稳定，正在重试）" },
        ]}
        choiceMode={false}
        notePrepError="草稿状态获取失败，请检查网络后重试"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/第 2 题/)).toBeInTheDocument();
    expect(
      screen.getByText(/草稿状态获取失败，请检查网络后重试/),
    ).toBeInTheDocument();
    // error 相不是明确选择分支：普通确认（重试）按钮存在、缺稿按钮不存在
    expect(
      screen.getByRole("button", { name: "确认交卷" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /提交答案，草稿未保存完整/ }),
    ).not.toBeInTheDocument();
  });

  it("T6R.10 busy 期间 Esc 与遮罩点按不关闭（关闭=取消=中止，准备中不可中断）", () => {
    const onCancel = vi.fn();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        preparing
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // Radix 弹层渲染在 body portal——从 document 取内容区
    const content = document.querySelector(
      "[data-slot='dialog-content']",
    ) as HTMLElement | null;
    expect(content).not.toBeNull();
    fireEvent.keyDown(content, { key: "Escape", code: "Escape" });
    fireEvent.pointerDown(content, { button: 0, detail: 1 });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
