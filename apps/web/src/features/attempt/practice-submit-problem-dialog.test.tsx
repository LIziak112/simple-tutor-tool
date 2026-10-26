import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PracticeSubmitProblemDialog } from "./PracticeQuestionSubmit";

/**
 * 逐题提交缺稿明确选择弹层（M3-D2，§10.3）：证据组装发现未追平草稿时不
 * 静默放行——choice 相给出 DraftProblemAlert 警示与「提交本题，草稿未保存
 * 完整」的明确选择；busy 相封堵关闭；error 相如实提示可关闭重试。组件级
 * 验证呈现与回调契约；接入链（outcome problems → 弹层）在 AttemptSession。
 */

it("choice 相：缺稿警示与明确选择按钮，确认/返回分别触发回调", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <PracticeSubmitProblemDialog
      open
      phase={{ kind: "choice", reason: "草稿还在上传，稍等片刻可同步完成" }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("这道题的草稿未保存完整");
  expect(
    screen.getByText("草稿还在上传，稍等片刻可同步完成"),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "提交本题，草稿未保存完整" }),
  );
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "返回作答" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("busy 相：封堵关闭路径——返回禁用、无确认按钮、显示同步文案", () => {
  const onCancel = vi.fn();
  render(
    <PracticeSubmitProblemDialog
      open
      phase={{ kind: "busy" }}
      onCancel={onCancel}
      onConfirm={() => {}}
    />,
  );
  expect(
    screen.getByText("正在同步草稿并提交本题，请稍候…"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回作答" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "提交本题，草稿未保存完整" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回作答" }));
  expect(onCancel).not.toHaveBeenCalled();
});

it("error 相：标题提交失败、错误文案可见，关闭触发 onCancel", () => {
  const onCancel = vi.fn();
  render(
    <PracticeSubmitProblemDialog
      open
      phase={{ kind: "error", message: "网络异常" }}
      onCancel={onCancel}
      onConfirm={() => {}}
    />,
  );
  expect(screen.getByText("提交失败")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("网络异常");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
