import { render, renderHook, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptTimerChip } from "./AttemptTimerChip";
import { formatElapsed, useAttemptTimer } from "./use-attempt-timer";

/**
 * 作答计时 hook + 顶栏计时块（阶段 B）：
 * - 已用时长以 startedAt 为基线、每秒推进、满一小时换 h:mm:ss；
 * - 距截止：无截止为 null；≤10 分钟标紧迫；到期文案「已截止」且不自动交卷
 *   （hook 不持有任何提交能力，只能回调 onDue）；
 * - startedAt 不可解析时安全归零。
 */
describe("useAttemptTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T08:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formatElapsed：mm:ss，满一小时后 h:mm:ss，负数归零", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65)).toBe("01:05");
    expect(formatElapsed(3600)).toBe("1:00:00");
    expect(formatElapsed(3725)).toBe("1:02:05");
    expect(formatElapsed(-5)).toBe("00:00");
  });

  it("已用时长以 startedAt 为基线并每秒推进", () => {
    const { result } = renderHook(() =>
      useAttemptTimer({
        startedAt: "2026-11-09T07:58:30.000Z",
        dueAt: null,
      }),
    );
    expect(result.current.elapsedSeconds).toBe(90);
    expect(result.current.elapsedLabel).toBe("01:30");
    expect(result.current.remaining).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.elapsedLabel).toBe("01:32");
  });

  it("startedAt 不可解析时安全归零，不抛错", () => {
    const { result } = renderHook(() =>
      useAttemptTimer({ startedAt: "not-a-date", dueAt: null }),
    );
    expect(result.current.elapsedSeconds).toBe(0);
    expect(result.current.elapsedLabel).toBe("00:00");
  });

  it("距截止：充裕时不紧迫；≤10 分钟紧迫；到期「已截止」并回调 onDue 一次", () => {
    const onDue = vi.fn();
    const { result } = renderHook(() =>
      useAttemptTimer({
        startedAt: "2026-11-09T07:00:00.000Z",
        dueAt: "2026-11-09T08:11:00.000Z",
        onDue,
      }),
    );
    expect(result.current.remaining).toEqual({
      label: "11 分 00 秒",
      expired: false,
      urgent: false,
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.remaining?.urgent).toBe(true);
    expect(result.current.remaining?.expired).toBe(false);
    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 1000);
    });
    expect(result.current.remaining).toEqual({
      label: "已截止",
      expired: true,
      urgent: false,
    });
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("天/小时级倒计时只到分钟，不逐秒抖动", () => {
    const { result } = renderHook(() =>
      useAttemptTimer({
        startedAt: "2026-11-09T07:00:00.000Z",
        dueAt: "2026-11-10T10:30:00.000Z",
      }),
    );
    expect(result.current.remaining?.label).toBe("1 天 2 小时");
  });
});

describe("AttemptTimerChip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T08:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("渲染已用时长与距截止；无截止只渲染已用", () => {
    const { rerender } = render(
      <AttemptTimerChip
        startedAt="2026-11-09T07:55:00.000Z"
        dueAt="2026-11-09T08:05:00.000Z"
      />,
    );
    expect(screen.getByText("已用 05:00")).toBeInTheDocument();
    expect(screen.getByText("距截止 5 分 00 秒")).toBeInTheDocument();
    rerender(
      <AttemptTimerChip startedAt="2026-11-09T07:55:00.000Z" dueAt={null} />,
    );
    expect(screen.getByText("已用 05:00")).toBeInTheDocument();
    expect(screen.queryByText(/距截止/)).toBeNull();
  });

  it("到期后文案「已截止」，不出现任何提交控件", () => {
    const { container } = render(
      <AttemptTimerChip
        startedAt="2026-11-09T07:00:00.000Z"
        dueAt="2026-11-09T07:30:00.000Z"
      />,
    );
    expect(screen.getByText("已截止")).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
  });
});
