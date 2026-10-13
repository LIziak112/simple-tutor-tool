import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PAPER_KEEPALIVE_MS, useRetainedPaper } from "./use-retained-paper";

afterEach(() => vi.useRealTimers());
it("保活期结束确认落盘才释放；写盘失败继续保留纸面", async () => {
  vi.useFakeTimers();
  const finish = vi.fn(async () => undefined);
  const view = renderHook(({ active }) => useRetainedPaper(active, finish), {
    initialProps: { active: true },
  });
  view.rerender({ active: false });
  expect(view.result.current).toBe(true);
  finish.mockRejectedValueOnce(new Error("磁盘已满"));
  await act(() => vi.advanceTimersByTimeAsync(PAPER_KEEPALIVE_MS));
  expect(view.result.current).toBe(true);
  view.rerender({ active: true });
  view.rerender({ active: false });
  await act(() => vi.advanceTimersByTimeAsync(PAPER_KEEPALIVE_MS));
  expect(view.result.current).toBe(false);
});
