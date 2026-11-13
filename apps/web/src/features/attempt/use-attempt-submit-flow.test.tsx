import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
  return renderHook(() =>
    useAttemptSubmitFlow({
      attemptId: "a",
      savedOnly: false,
      recoveryReady: true,
      syncDraft,
      flushAnswers: ready,
      inkControllers: { current: new Map() },
      questionIds: [],
      revisions: [],
      events: { finalizeSubmit: finalizeEvents, confirmSubmit: () => {} },
      onAnnotationSealFailed: () => {},
    }),
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
