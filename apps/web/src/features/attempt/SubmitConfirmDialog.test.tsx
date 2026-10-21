import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatDueTime } from "@/lib/time";
import { SubmitConfirmDialog } from "./SubmitConfirmDialog";

/** 交卷确认弹层测试（T2.6）：未答数量提示与确认/继续作答回调。 */

/** 相对当前时刻的未来截止（避免硬编码日期随时间推移翻转成已过截止） */
function futureDueIso(): string {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

describe("SubmitConfirmDialog", () => {
  it("待传标画提示仅交答案、本机保留且不能冒称交卷原稿", () => {
    const confirm = vi.fn();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        choiceMode
        noteProblems={[
          { index: 1, reason: "标画尚未上传完整", domain: "annotation" },
        ]}
        onConfirm={vi.fn()}
        onConfirmMissing={confirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/本机标画不会删除/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "仅交答案，未保存材料留在本机" }),
    );
    expect(confirm).toHaveBeenCalledOnce();
  });
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

  it("截止后公布模式下，全部作答展示截止时间前置预期", () => {
    const dueAt = futureDueIso();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        answerRelease="after_due"
        dueAt={dueAt}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        `全部题目已作答。老师设置了截止后公布，交卷后答案将妥善保存，成绩与详解将在截止后（${formatDueTime(dueAt)}）统一公布。确认交卷吗？`,
      ),
    ).toBeInTheDocument();
  });

  it("截止后公布模式下，有未答题展示具体未答题数与截止时间前置预期", () => {
    const dueAt = futureDueIso();
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={2}
        submitting={false}
        answerRelease="after_due"
        dueAt={dueAt}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        `还有 2 题没有作答。老师设置了截止后公布，交卷后答案将妥善保存，成绩与详解将在截止后（${formatDueTime(dueAt)}）统一公布。确认交卷吗？`,
      ),
    ).toBeInTheDocument();
  });

  it("on_submit 即使设了未来截止也不展示「截止后公布」预期（交卷即出分，防误导）", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={0}
        submitting={false}
        answerRelease="on_submit"
        dueAt={futureDueIso()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText("全部题目已作答，交卷后立即判分且不能再修改答案。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/截止后公布/)).toBeNull();
  });

  it("after_due 但截止已过：交卷即完整公布，回到立即判分文案", () => {
    render(
      <SubmitConfirmDialog
        open
        unansweredCount={1}
        submitting={false}
        answerRelease="after_due"
        dueAt={new Date(Date.now() - 3600 * 1000).toISOString()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText("还有 1 题没有作答，交卷后不能再修改答案。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/截止后公布/)).toBeNull();
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
    // Radix 弹层渲染在 body portal——从 document 取内容区（守卫窄化）
    const content = document.querySelector("[data-slot='dialog-content']");
    if (content === null)
      throw new Error("dialog content 不存在（测试前置失败）");
    fireEvent.keyDown(content, { key: "Escape", code: "Escape" });
    fireEvent.pointerDown(content, { button: 0, detail: 1 });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
