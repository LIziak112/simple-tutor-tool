import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveDraftAnswer } from "./attempt-queries";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";
import { useAttemptAnswers } from "./use-attempt-answers";

vi.mock("./attempt-queries", () => ({
  saveDraftAnswer: vi.fn(async () => ({})),
}));
const save = vi.mocked(saveDraftAnswer);
const drafts = {};
beforeEach(() => {
  vi.useFakeTimers();
  installDraftBackend(memoryBackend());
  save.mockReset().mockResolvedValue({ questionId: "q", changeCount: 1 });
});
afterEach(() => {
  vi.useRealTimers();
});

it("交卷flush立即提交600ms防抖窗内最新答案，之后不再迟到PUT", async () => {
  const { result } = renderHook(() => useAttemptAnswers("fast-submit", drafts));
  act(() =>
    result.current.setAnswer("q", { kind: "fill", values: ["6"] }, true),
  );
  expect(save).not.toHaveBeenCalled();
  await act(async () => result.current.flush());
  expect(save).toHaveBeenCalledExactlyOnceWith("fast-submit", "q", {
    kind: "fill",
    values: ["6"],
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(save).toHaveBeenCalledOnce();
});
it("答案上传失败阻断flush，本机答案保留；重试成功才能继续", async () => {
  const { result } = renderHook(() =>
    useAttemptAnswers("failed-submit", drafts),
  );
  act(() =>
    result.current.setAnswer("q", { kind: "fill", values: ["6"] }, true),
  );
  save.mockRejectedValueOnce(new Error("断网"));
  await act(async () => {
    await expect(result.current.flush()).rejects.toThrow("答案尚未保存");
  });
  expect((await draftStore.loadDraft("failed-submit"))?.answers.q).toEqual({
    kind: "fill",
    values: ["6"],
  });
  await act(async () => result.current.flush());
  expect(save).toHaveBeenCalledTimes(2);
});
it("flush等待旧在途请求后再提交新答案，旧回执不覆写本机新值", async () => {
  let done: (() => void) | undefined;
  save.mockImplementationOnce(
    () =>
      new Promise<Awaited<ReturnType<typeof saveDraftAnswer>>>((resolve) => {
        done = () => resolve({ questionId: "q", changeCount: 1 });
      }),
  );
  const { result } = renderHook(() =>
    useAttemptAnswers("inflight-submit", drafts),
  );
  act(() => result.current.setAnswer("q", { kind: "fill", values: ["6"] }));
  act(() =>
    result.current.setAnswer("q", { kind: "fill", values: ["7"] }, true),
  );
  let completed = false;
  let flushing: Promise<void> | undefined;
  act(() => {
    flushing = result.current.flush().then(() => {
      completed = true;
    });
  });
  expect(completed).toBe(false);
  await act(async () => {
    done?.();
    await flushing;
  });
  expect(save).toHaveBeenLastCalledWith("inflight-submit", "q", {
    kind: "fill",
    values: ["7"],
  });
  expect((await draftStore.loadDraft("inflight-submit"))?.answers.q).toEqual({
    kind: "fill",
    values: ["7"],
  });
});
