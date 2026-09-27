import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { AttemptBottomBar } from "./AttemptBottomBar";

/**
 * 吸底操作条组件测试（T2.12 验收项「离线时禁用交卷并提示」）：
 * - 在线：交卷按钮可用、无离线提示；
 * - 离线：按钮 disabled + 提示「离线中，已作答内容保存在本机，恢复网络后可交卷」；
 * - 离线不影响其他错误提示的展示；空试卷仍禁用。
 */

/** 渲染底栏并补齐缺省 props（Partial 展开不能满足必填类型，先合并成完整对象） */
function renderBar(
  props: Partial<ComponentProps<typeof AttemptBottomBar>> = {},
) {
  const onOpenSubmit = vi.fn();
  const merged: ComponentProps<typeof AttemptBottomBar> = {
    answered: 0,
    total: 5,
    offline: false,
    saveFailed: false,
    inkFlushError: false,
    submitError: null,
    ...props,
    onOpenSubmit: props.onOpenSubmit ?? onOpenSubmit,
  };
  return {
    onOpenSubmit,
    ...render(<AttemptBottomBar {...merged} />),
  };
}

describe("AttemptBottomBar（离线交卷保护，T2.12）", () => {
  it("在线：按钮可点击，无离线提示", () => {
    const { onOpenSubmit } = renderBar({
      answered: 2,
      total: 5,
      offline: false,
    });
    const button = screen.getByRole("button", { name: "交卷" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onOpenSubmit).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/离线中，已作答内容保存在本机/),
    ).not.toBeInTheDocument();
  });

  it("离线：按钮禁用并展示提示文案", () => {
    const { onOpenSubmit } = renderBar({
      answered: 2,
      total: 5,
      offline: true,
    });
    const button = screen.getByRole("button", { name: "交卷" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOpenSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("离线中，已作答内容保存在本机，恢复网络后可交卷"),
    ).toBeInTheDocument();
  });

  it("离线与其他错误提示可同时展示（不互相顶掉）", () => {
    renderBar({
      answered: 1,
      total: 5,
      offline: true,
      saveFailed: true,
      submitError: "交卷失败，请稍后重试",
    });
    expect(
      screen.getByText("离线中，已作答内容保存在本机，恢复网络后可交卷"),
    ).toBeInTheDocument();
    expect(screen.getByText(/有答案保存失败/)).toBeInTheDocument();
    expect(screen.getByText("交卷失败，请稍后重试")).toBeInTheDocument();
  });

  it("空试卷（total=0）时无论在线离线都禁用", () => {
    renderBar({ answered: 0, total: 0, offline: false });
    expect(screen.getByRole("button", { name: "交卷" })).toBeDisabled();
  });
});
