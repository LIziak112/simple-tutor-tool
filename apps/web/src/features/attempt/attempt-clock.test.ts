import type { AttemptTiming } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test/render-with-portal";
import { useAttemptClock, useAttemptPhase } from "./attempt-clock";

const serverNow = Date.parse("2026-11-10T09:00:00Z");
const timing: AttemptTiming = {
  serverNow: new Date(serverNow).toISOString(),
  deadlineAt: new Date(serverNow + 30_000).toISOString(),
  timeLimitSec: 60,
  graceSec: 600,
  phase: "running",
};

describe("限时作答时钟", () => {
  afterEach(() => vi.useRealTimers());

  it("缓存重挂载使用首次收到响应的单调时间", () => {
    vi.useFakeTimers({
      toFake: ["performance", "setInterval", "clearInterval"],
    });
    const receivedAt = performance.now();
    vi.advanceTimersByTime(31_000);
    const { result } = renderHook(() => useAttemptClock(timing, receivedAt));
    expect(result.current?.phase).toBe("grace");
  });

  it("系统时间前拨不结束作答，真实经过截止后仍进入宽限", () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setInterval", "clearInterval"],
    });
    const receivedAt = performance.now();
    const { result } = renderHook(() => useAttemptClock(timing, receivedAt));
    vi.setSystemTime(Date.now() + 3_600_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current?.remainingMs).toBe(29_000);
    act(() => vi.advanceTimersByTime(29_000));
    expect(result.current?.phase).toBe("grace");
  });

  it("阶段订阅只在截止和宽限边界触发重新渲染", () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const receivedAt = performance.now();
    const rendered = vi.fn();
    const { result } = renderHook(() => {
      rendered();
      return useAttemptPhase(timing, receivedAt);
    });
    expect(result.current).toBe("running");
    const initialRenders = rendered.mock.calls.length;
    act(() => vi.advanceTimersByTime(29_000));
    expect(rendered).toHaveBeenCalledTimes(initialRenders);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("grace");
    act(() => vi.advanceTimersByTime(600_000));
    expect(result.current).toBe("locked");
  });
});
