import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDueCountdown } from "./use-due-countdown";

describe("useDueCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dueAt 为 null 时，返回已到期状态且不报错，倒计时不运行", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useDueCountdown(null, { onExpire }));

    expect(result.current.isExpired).toBe(true);
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.days).toBe(0);
    expect(result.current.hours).toBe(0);
    expect(result.current.minutes).toBe(0);
    expect(result.current.seconds).toBe(0);
    expect(result.current.formatted).toBe("已截止");
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("dueAt 已经是过去的时间时，直接判定为过期，不重复触发 onExpire", () => {
    const onExpire = vi.fn();
    const pastDue = new Date(Date.now() - 10000).toISOString();
    const { result } = renderHook(() => useDueCountdown(pastDue, { onExpire }));

    expect(result.current.isExpired).toBe(true);
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.formatted).toBe("已截止");
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("正确拆分剩余天、时、分、秒与格式化字符串", () => {
    // 设定未来 2天 3小时 4分 5秒
    const now = new Date("2026-10-21T10:00:00.000Z");
    vi.setSystemTime(now);

    const ms = ((2 * 24 + 3) * 60 + 4) * 60 * 1000 + 5 * 1000;
    const futureDue = new Date(now.getTime() + ms).toISOString();

    const { result } = renderHook(() => useDueCountdown(futureDue));

    expect(result.current.isExpired).toBe(false);
    expect(result.current.days).toBe(2);
    expect(result.current.hours).toBe(3);
    expect(result.current.minutes).toBe(4);
    expect(result.current.seconds).toBe(5);
    expect(result.current.formatted).toContain("2天");
    expect(result.current.formatted).toContain("3小时");
    expect(result.current.formatted).toContain("4分");
    expect(result.current.formatted).toContain("5秒");
  });

  it("每秒递减，当倒计时到 0 时触发 onExpire 且只触发一次", () => {
    const now = new Date("2026-10-21T10:00:00.000Z");
    vi.setSystemTime(now);

    const onExpire = vi.fn();
    // 剩余 2 秒
    const futureDue = new Date(now.getTime() + 2000).toISOString();

    const { result } = renderHook(() =>
      useDueCountdown(futureDue, { onExpire }),
    );

    expect(result.current.isExpired).toBe(false);
    expect(result.current.seconds).toBe(2);
    expect(onExpire).not.toHaveBeenCalled();

    // 前进 1 秒
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.seconds).toBe(1);
    expect(result.current.isExpired).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();

    // 前进 1 秒到达截止点
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.seconds).toBe(0);
    expect(result.current.isExpired).toBe(true);
    expect(onExpire).toHaveBeenCalledTimes(1);

    // 再过几秒，不应该再次触发 onExpire
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
