import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PracticeSingleActions } from "./PracticeQuestionSubmit";
import {
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
