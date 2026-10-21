import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingReleaseBanner } from "./PendingReleaseBanner";

describe("PendingReleaseBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("渲染绿色 Hero 成功交卷确认区和文案", () => {
    render(
      <PendingReleaseBanner
        dueAt="2026-10-25T12:00:00.000Z"
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 5, total: 6 }}
      />,
    );

    expect(screen.getByText("🎉 作业已成功交卷！")).toBeInTheDocument();
    expect(
      screen.getByText("作答与过程草稿已妥善保存，请放心休息。"),
    ).toBeInTheDocument();
  });

  it("渲染作答凭证摘要行各字段及待公布提示", () => {
    render(
      <PendingReleaseBanner
        dueAt="2026-10-25T12:00:00.000Z"
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 5, total: 6 }}
      />,
    );

    expect(screen.getByText("已作答题数")).toBeInTheDocument();
    expect(screen.getByText("5 / 6 题")).toBeInTheDocument();
    expect(screen.getByText("手写原稿状态")).toBeInTheDocument();
    expect(screen.getByText("已归档保存")).toBeInTheDocument();
    expect(screen.getByText("得分状态")).toBeInTheDocument();
    expect(screen.getByText("待公布 🔒（截止后自动判分）")).toBeInTheDocument();
  });

  it("渲染倒计时胶囊卡片并在倒计时到达时显示加载状态和触发 onRefresh", () => {
    const now = new Date("2026-10-21T10:00:00.000Z");
    vi.setSystemTime(now);

    const onRefresh = vi.fn();
    // 2 秒后截止
    const dueAt = new Date(now.getTime() + 2000).toISOString();

    render(
      <PendingReleaseBanner
        dueAt={dueAt}
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 6, total: 6 }}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("成绩公布倒计时")).toBeInTheDocument();
    expect(screen.getByText("天")).toBeInTheDocument();
    expect(screen.getByText("时")).toBeInTheDocument();
    expect(screen.getByText("分")).toBeInTheDocument();
    expect(screen.getByText("秒")).toBeInTheDocument();

    // 触发截止
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("截止时间已到，正在加载批改结果…"),
    ).toBeInTheDocument();
  });

  it("到期态提供「立即刷新」手动重试（自动刷新后仍未公布时不卡死）", () => {
    const now = new Date("2026-10-21T10:00:00.000Z");
    vi.setSystemTime(now);

    const onRefresh = vi.fn();
    const dueAt = new Date(now.getTime() + 1000).toISOString();

    render(
      <PendingReleaseBanner
        dueAt={dueAt}
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 6, total: 6 }}
        onRefresh={onRefresh}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // 到期自动触发一次
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // 自动刷新后服务端仍未公布（时钟偏差等）→ 学生可手动重试
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("dueAt 缺失的防御分支：不谎称正在加载，展示中性待公布文案", () => {
    render(
      <PendingReleaseBanner
        dueAt={null}
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 6, total: 6 }}
      />,
    );

    expect(
      screen.getByText("老师公布后将在这里显示成绩、参考答案与详解。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/正在加载批改结果/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("渲染防疑惑科普小贴士", () => {
    render(
      <PendingReleaseBanner
        dueAt="2026-10-25T12:00:00.000Z"
        submittedAt="2026-10-21T08:30:00.000Z"
        summary={{ answered: 6, total: 6 }}
      />,
    );

    expect(screen.getByText("为什么不在交卷后立即出分？")).toBeInTheDocument();
    expect(
      screen.getByText(/为保障全班同学独立思考和练习公平/i),
    ).toBeInTheDocument();
  });
});
