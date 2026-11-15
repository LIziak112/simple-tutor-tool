import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test/render-with-portal";
import { useAttemptSubmitFlow } from "./use-attempt-submit-flow";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ declarations: [], problems: [] })),
  send: vi.fn(async () => {}),
  seal: vi.fn(async () => {}),
}));
vi.mock("@/features/notes/submit-evidence", () => ({
  prepareSubmitEvidence: mocks.prepare,
}));
vi.mock("./attempt-queries", () => ({
  useSubmitAttempt: () => ({
    mutateAsync: mocks.send,
    verificationRequired: false,
  }),
}));
vi.mock("@/lib/api", () => ({ sealAttemptAnnotationsApi: mocks.seal }));

const never = () => new Promise<void>(() => {});
const ready = async () => {};
const context = {
  missingConfirmed: null,
  clearMissingConfirmed: () => {},
  enterSubmitting: () => {},
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderSubmit(syncDraft = ready, finalizeEvents = ready) {
  return renderHook(
    ({ savedOnly }: { savedOnly: boolean }) =>
      useAttemptSubmitFlow({
        attemptId: "a",
        savedOnly,
        recoveryReady: true,
        syncDraft,
        flushAnswers: ready,
        inkControllers: { current: new Map() },
        questionIds: [],
        revisions: [],
        events: { finalizeSubmit: finalizeEvents, confirmSubmit: () => {} },
        onAnnotationSealFailed: () => {},
      }),
    { initialProps: { savedOnly: false } },
  );
}

it("学情请求挂起时仍可提交作答和证据", async () => {
  const hook = renderSubmit(ready, never);
  await act(async () => {
    await expect(hook.result.current.runSubmit(context)).resolves.toEqual({
      kind: "submitted",
    });
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

/** 手动放行的学情收口（finalizeSubmit 的替身） */
function heldEvents() {
  let release: () => void = () => {};
  const finalize = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { finalize, release: () => release() };
}

// 服务端在交卷那一刻封存用时，只算已收到的事件：交卷请求要排在事件后面
it("交卷前先收口学情事件：作答和证据备齐后送事件，事件送到了才发交卷请求", async () => {
  const events = heldEvents();
  const hook = renderSubmit(ready, events.finalize);
  await act(async () => {
    const pending = hook.result.current.runSubmit(context);
    await vi.waitFor(() => expect(events.finalize).toHaveBeenCalledTimes(1));
    // 事件还在路上：交卷请求不抢跑
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.send).not.toHaveBeenCalled();
    events.release();
    await expect(pending).resolves.toEqual({ kind: "submitted" });
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    events.finalize.mock.invocationCallOrder[0] ?? 0,
  );
});

it("学情事件上报失败不拦交卷", async () => {
  const hook = renderSubmit(ready, () =>
    Promise.reject(new Error("学情接口失败")),
  );
  await act(async () => {
    await expect(hook.result.current.runSubmit(context)).resolves.toEqual({
      kind: "submitted",
    });
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it("等学情事件期间宽限到期：不发普通交卷，提示改按已保存作答交卷", async () => {
  const events = heldEvents();
  const hook = renderSubmit(ready, events.finalize);
  let pending: ReturnType<typeof hook.result.current.runSubmit> | undefined;
  act(() => {
    pending = hook.result.current.runSubmit(context);
  });
  await vi.waitFor(() => expect(events.finalize).toHaveBeenCalledTimes(1));
  // 宽限到期：页面改成「只按已保存作答交卷」
  hook.rerender({ savedOnly: true });
  events.release();
  await act(async () => {
    await expect(pending).resolves.toEqual({
      kind: "error",
      message: "宽限已过，请重新确认按已保存作答交卷",
    });
  });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("同步超过准备期限时恢复交互，晚到成功也不会提交", async () => {
  vi.useFakeTimers();
  let finish = () => {};
  const hook = renderSubmit(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    const pending = hook.result.current.runSubmit(context);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("超时"),
    });
    finish();
  });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
