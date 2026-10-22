import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveDraftAnswer } from "./attempt-queries";
import {
  draftStore,
  getDraftPersistenceState,
  installDraftBackend,
  memoryBackend,
  type KVBackend,
} from "./draft-store";
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

// ---------- M3-D3：按题 flush（§11-4 提交第 8 题不等第 19 题网络重试） ----------

it("flushQuestionLocal取消该题防抖立即保存并等待本机落盘，不触发其他题", async () => {
  const { result } = renderHook(() => useAttemptAnswers("q-local", drafts));
  act(() =>
    result.current.setAnswer("q8", { kind: "fill", values: ["8"] }, true),
  );
  act(() =>
    result.current.setAnswer("q19", { kind: "fill", values: ["19"] }, true),
  );
  expect(save).not.toHaveBeenCalled();
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestionLocal("q8");
  });
  expect(ok).toBe(true);
  // 只立即保存 q8；q19 仍在防抖窗内不受影响
  expect(save).toHaveBeenCalledExactlyOnceWith("q-local", "q8", {
    kind: "fill",
    values: ["8"],
  });
  // 本机已写后端（IndexedDB 写完成，非仅内存）
  expect(getDraftPersistenceState("q-local")).toBe("saved");
  expect((await draftStore.loadDraft("q-local"))?.answers.q8).toEqual({
    kind: "fill",
    values: ["8"],
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(save).toHaveBeenCalledTimes(2); // q19 防抖到期照常保存
  expect(save).toHaveBeenLastCalledWith("q-local", "q19", {
    kind: "fill",
    values: ["19"],
  });
});

it("flushQuestionLocal服务端失败不阻塞本机落盘结果（离线可切题）", async () => {
  save.mockRejectedValue(new Error("断网"));
  const { result } = renderHook(() => useAttemptAnswers("offline-q", drafts));
  act(() =>
    result.current.setAnswer("q8", { kind: "fill", values: ["8"] }, true),
  );
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestionLocal("q8");
  });
  expect(ok).toBe(true);
  expect((await draftStore.loadDraft("offline-q"))?.answers.q8).toEqual({
    kind: "fill",
    values: ["8"],
  });
});

it("flushQuestionLocal本机写失败返回false（IndexedDB 异常不放行切题）", async () => {
  const failing: KVBackend = {
    get: async () => undefined,
    set: async () => {
      throw new Error("配额不足");
    },
    del: async () => {},
  };
  installDraftBackend(failing);
  const { result } = renderHook(() => useAttemptAnswers("q-fail", drafts));
  act(() => result.current.setAnswer("q8", { kind: "fill", values: ["8"] }));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestionLocal("q8");
  });
  expect(ok).toBe(false);
  expect(getDraftPersistenceState("q-fail")).toBe("failed");
});

it("flushQuestion等待该题在途请求并确认服务端同步，不等其他题在途", async () => {
  let releaseQ19: (() => void) | undefined;
  save.mockImplementation(
    async (_attemptId: string, questionId: string) => {
      if (questionId === "q19") {
        return new Promise<Awaited<ReturnType<typeof saveDraftAnswer>>>(
          (resolve) => {
            releaseQ19 = () =>
              resolve({ questionId, changeCount: 1 });
          },
        );
      }
      return { questionId, changeCount: 1 };
    },
  );
  const { result } = renderHook(() => useAttemptAnswers("per-q", drafts));
  act(() => result.current.setAnswer("q19", { kind: "fill", values: ["19"] }));
  act(() =>
    result.current.setAnswer("q8", { kind: "fill", values: ["8"] }, true),
  );
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestion("q8");
  });
  // q8 已确认同步（防抖取消+该题在途追平）；q19 在途请求未被等待
  expect(ok).toBe(true);
  expect(save).toHaveBeenLastCalledWith("per-q", "q8", {
    kind: "fill",
    values: ["8"],
  });
  expect(releaseQ19).toBeDefined();
  // 全局 flush 行为零变化：仍等待全部在途（q19 未释放前不完成）
  let globalDone = false;
  act(() => {
    void result.current.flush().then(() => {
      globalDone = true;
    });
  });
  expect(globalDone).toBe(false);
  await act(async () => {
    releaseQ19?.();
  });
  await act(async () => {});
  expect(globalDone).toBe(true);
});

it("flushQuestion该题保存失败时重试一次再判定失败", async () => {
  save
    .mockRejectedValueOnce(new Error("断网"))
    .mockRejectedValueOnce(new Error("仍断网"));
  const { result } = renderHook(() => useAttemptAnswers("retry-q", drafts));
  act(() => result.current.setAnswer("q8", { kind: "fill", values: ["8"] }));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestion("q8");
  });
  expect(ok).toBe(false);
  expect(save).toHaveBeenCalledTimes(2); // 在途失败后补重试一次
  // 该题答案内容本机保留
  expect((await draftStore.loadDraft("retry-q"))?.answers.q8).toEqual({
    kind: "fill",
    values: ["8"],
  });
});

it("flushQuestion重试成功则确认同步（判true）", async () => {
  save
    .mockRejectedValueOnce(new Error("断网"))
    .mockResolvedValueOnce({ questionId: "q8", changeCount: 1 });
  const { result } = renderHook(() => useAttemptAnswers("retry-ok", drafts));
  act(() => result.current.setAnswer("q8", { kind: "fill", values: ["8"] }));
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestion("q8");
  });
  expect(ok).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});

it("flushQuestion该题存在待裁决冲突时不放行且不自动重传", async () => {
  const { result } = renderHook(() => useAttemptAnswers("conflict-q", drafts));
  act(() => result.current.setAnswer("q8", { kind: "fill", values: ["8"] }));
  act(() =>
    draftStore.setAnswerConflict("conflict-q", "q8", {
      revision: 3,
      draft: { kind: "fill", values: ["9"] },
    }),
  );
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.flushQuestion("q8");
  });
  expect(ok).toBe(false);
  expect(save).toHaveBeenCalledTimes(1); // 冲突需用户裁决，不自动重传
});
