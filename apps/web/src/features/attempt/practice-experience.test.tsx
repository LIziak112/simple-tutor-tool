import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PracticeSingleActions } from "./PracticeQuestionSubmit";
import {
  PracticeModeDialog,
  PracticeModeSummary,
  SingleQuestionActionBar,
} from "./PracticeWorkspace";
import { workflowOf } from "./practice-test-fixtures";

const actions = {
  submitted: false,
  answered: false,
  busy: false,
  finished: false,
  hasNext: true,
  continueUnsubmittedId: null,
  error: null,
  onSubmit: vi.fn(),
  onNext: vi.fn(),
  onViewResult: vi.fn(),
  onContinue: vi.fn(),
};

it("整卷反馈只能切下一题，不承诺逐题提交与即时解析", () => {
  const next = vi.fn();
  render(
    <PracticeSingleActions
      {...actions}
      canSubmitQuestion={false}
      onNext={next}
    />,
  );
  expect(screen.queryByRole("button", { name: "提交本题" })).toBeNull();
  expect(screen.queryByRole("button", { name: /提交并看解析/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  expect(next).toHaveBeenCalledOnce();
});

it("整卷反馈末题提供交卷入口", () => {
  const finish = vi.fn();
  render(
    <PracticeSingleActions
      {...actions}
      hasNext={false}
      canSubmitQuestion={false}
      onFinish={finish}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "交卷" }));
  expect(finish).toHaveBeenCalledOnce();
});

it("整卷反馈末题交卷沿用离线与权限保护，仍允许浏览下一题", () => {
  const view = render(
    <PracticeSingleActions
      {...actions}
      hasNext={false}
      canSubmitQuestion={false}
      finishDisabled
    />,
  );
  expect(screen.getByRole("button", { name: "交卷" })).toBeDisabled();
  view.rerender(
    <PracticeSingleActions
      {...actions}
      canSubmitQuestion={false}
      finishDisabled
    />,
  );
  expect(screen.getByRole("button", { name: "下一题" })).toBeEnabled();
});

it("已提交题的操作栏只有一个下一题", () => {
  render(
    <SingleQuestionActionBar
      hasPrev={false}
      hasNext
      onPrev={vi.fn()}
      onNext={vi.fn()}
      middle={<PracticeSingleActions {...actions} submitted />}
    />,
  );
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(1);
});

it("未作答只有一个提交类主动作：不会，提交并看解析（无禁用的提交本题）", () => {
  const submit = vi.fn();
  render(<PracticeSingleActions {...actions} onSubmit={submit} />);
  expect(screen.queryByRole("button", { name: "提交本题" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "不会，提交并看解析" }));
  expect(submit).toHaveBeenCalledOnce();
});

it("已作答只有提交本题，不再并列「不会」入口", () => {
  render(<PracticeSingleActions {...actions} answered />);
  expect(screen.getByRole("button", { name: "提交本题" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /不会/ })).toBeNull();
});

it("单题操作条嵌在吸底栏内，不再自带边框卡片", () => {
  const { container } = render(
    <SingleQuestionActionBar
      showNext
      hasPrev
      hasNext
      onPrev={vi.fn()}
      onNext={vi.fn()}
      middle={<PracticeSingleActions {...actions} />}
    />,
  );
  const bar = container.querySelector('[data-slot="practice-action-bar"]');
  expect(bar?.className).not.toMatch(/\bborder\b/);
  expect(screen.getByRole("button", { name: "上一题" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "下一题" })).toBeEnabled();
});

it("做题方式弹窗复用同一编辑器：切换布局即回调并收起", () => {
  const layoutChange = vi.fn();
  const openChange = vi.fn();
  render(
    <PracticeModeDialog
      open
      onOpenChange={openChange}
      workflow={workflowOf()}
      layout="single"
      onLayoutChange={layoutChange}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "做题方式" });
  expect(dialog).toHaveTextContent("做题方式：单题 · 每题提交后查看");
  fireEvent.click(screen.getByRole("radio", { name: "列表作答" }));
  expect(layoutChange).toHaveBeenCalledWith("list");
  expect(openChange).toHaveBeenCalledWith(false);
});

it("首题提交后解释反馈节奏锁定原因", () => {
  render(
    <PracticeModeSummary
      workflow={workflowOf({ canChangeFeedback: false })}
      layout="single"
      onLayoutChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "调整做题方式" }));
  expect(screen.getByText(/本卷已有题目提交/)).toBeInTheDocument();
});
