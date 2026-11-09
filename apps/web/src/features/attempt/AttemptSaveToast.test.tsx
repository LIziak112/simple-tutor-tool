import { render, renderHook, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttemptSaveToast,
  saveToastTransition,
  useSaveToast,
} from "./AttemptSaveToast";

/**
 * 草稿自动保存轻提示（阶段 B）：只在「正在保存 → 已保存」边沿亮一次、
 * 停留后自动消失；静止态与错误态不提示；读屏由 sr-only 状态播报，本件 aria-hidden。
 */
describe("saveToastTransition", () => {
  it("正在保存 → 全部已保存 = saved；→ 离线/等待同步 = local", () => {
    expect(saveToastTransition("正在保存到本机…", "全部已保存")).toBe("saved");
    expect(saveToastTransition("已存本机，正在同步…", "全部已保存")).toBe(
      "saved",
    );
    expect(saveToastTransition("正在保存到本机…", "离线，已存本机")).toBe(
      "local",
    );
    expect(saveToastTransition("正在保存到本机…", "已存本机，等待同步")).toBe(
      "local",
    );
  });
  it("首帧、无变化、非保存态起点、错误终点都不提示", () => {
    expect(saveToastTransition(null, "全部已保存")).toBeNull();
    expect(saveToastTransition("全部已保存", "全部已保存")).toBeNull();
    expect(saveToastTransition("离线，已存本机", "全部已保存")).toBeNull();
    expect(
      saveToastTransition(
        "正在保存到本机…",
        "本机保存失败，请保持页面打开并重试",
      ),
    ).toBeNull();
    expect(
      saveToastTransition("正在保存到本机…", "有答案同步冲突，请选择保留版本"),
    ).toBeNull();
  });
});

describe("useSaveToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("边沿亮起并在停留时长后自动消失；静止态不反复亮", () => {
    const { result, rerender } = renderHook(
      ({ status }) => useSaveToast(status, 1000),
      { initialProps: { status: "全部已保存" } },
    );
    expect(result.current).toBeNull();
    rerender({ status: "正在保存到本机…" });
    expect(result.current).toBeNull();
    rerender({ status: "全部已保存" });
    expect(result.current).toBe("saved");
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe("saved");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();
    // 状态保持「全部已保存」不再亮
    rerender({ status: "全部已保存" });
    expect(result.current).toBeNull();
  });

  it("载入期：恢复 → 首次同步 → 全部已保存 不亮；之后用户作答的边沿才亮", () => {
    const { result, rerender } = renderHook(
      ({ status }) => useSaveToast(status, 1000),
      { initialProps: { status: "正在恢复作答与材料…" } },
    );
    rerender({ status: "已存本机，正在同步…" });
    rerender({ status: "全部已保存" });
    expect(result.current).toBeNull();
    rerender({ status: "正在保存到本机…" });
    rerender({ status: "全部已保存" });
    expect(result.current).toBe("saved");
  });

  it("连续两次保存各亮一次（第二次重置停留计时）", () => {
    const { result, rerender } = renderHook(
      ({ status }) => useSaveToast(status, 1000),
      { initialProps: { status: "全部已保存" } },
    );
    rerender({ status: "正在保存到本机…" });
    rerender({ status: "全部已保存" });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    rerender({ status: "已存本机，正在同步…" });
    rerender({ status: "全部已保存" });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // 第二次亮起后 800ms 仍在（计时已重置）
    expect(result.current).toBe("saved");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBeNull();
  });
});

describe("AttemptSaveToast", () => {
  it("saved 显示「已保存」、local 显示「已存本机」、null 不渲染；对读屏隐藏", () => {
    const { container, rerender } = render(<AttemptSaveToast kind="saved" />);
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="attempt-save-toast"]'),
    ).toHaveAttribute("aria-hidden", "true");
    rerender(<AttemptSaveToast kind="local" />);
    expect(screen.getByText("已存本机")).toBeInTheDocument();
    rerender(<AttemptSaveToast kind={null} />);
    expect(
      container.querySelector('[data-slot="attempt-save-toast"]'),
    ).toBeNull();
  });
});
