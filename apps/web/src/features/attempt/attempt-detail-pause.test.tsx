import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { AttemptDraftData } from "@tutor/contract";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearAccountQueries } from "@/features/auth/account-query-cache";
import {
  ApiError,
  AttemptDetailReadTimeoutError,
  fetchAttemptApi,
} from "@/lib/api";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import {
  pauseAttemptDetailPolling,
  resumeAttemptDetailPolling,
  studentAttemptKey,
  useAttemptDetail,
} from "./attempt-queries";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAttemptApi: vi.fn(),
}));
const draft: AttemptDraftData = {
  attempt: {
    id: "pause-test",
    sourceType: "course",
    assignmentId: null,
    lectureId: null,
    courseId: "33333333-3333-4333-8333-333333333333",
    unitId: "unit-test",
    attemptNo: 1,
    status: "draft",
    startedAt: "2026-10-23T00:00:00Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "暂停回归",
  courseName: null,
  dueAt: null,
  units: [],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: [],
};
beforeEach(() => {
  vi.mocked(fetchAttemptApi).mockReset();
});
afterEach(() => {
  resumeAttemptDetailPolling("pause-test");
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

it("已在途详情读取失败时，暂停中的末题阅读不变成错误页", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(studentAttemptKey("pause-test"), draft);
  let rejectRead: ((error: Error) => void) | undefined;
  vi.mocked(fetchAttemptApi).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useAttemptDetail("pause-test"), {
    wrapper,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
    pauseAttemptDetailPolling("pause-test");
  });
  await act(async () => {
    rejectRead?.(new Error("读取失败"));
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.isError).toBe(false);
  expect(result.current.data?.attempt.status).toBe("draft");
  unmount();
  client.clear();
});

it("末题阅读暂停时，已在途的权限撤销仍不能保留可写旧卷", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(studentAttemptKey("pause-test"), draft);
  let rejectRead: ((error: Error) => void) | undefined;
  vi.mocked(fetchAttemptApi).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useAttemptDetail("pause-test"), {
    wrapper,
  });
  await waitFor(() => expect(rejectRead).toBeDefined());
  await act(async () => {
    pauseAttemptDetailPolling("pause-test");
    rejectRead?.(new ApiError("COURSE_ACCESS_DENIED", "已撤销权限", 403));
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBeInstanceOf(ApiError);
  expect(result.current.data).toEqual(draft);
  unmount();
  client.clear();
});

it("收尾暂停后跨轮询与重连保持草稿视图，主动恢复后读取结果", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(fetchAttemptApi).mockResolvedValue(draft);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useAttemptDetail("pause-test"), {
    wrapper,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data?.attempt.status).toBe("draft");
  const count = vi.mocked(fetchAttemptApi).mock.calls.length;
  vi.mocked(fetchAttemptApi).mockResolvedValue({
    ...draft,
    attempt: { ...draft.attempt, status: "submitted" },
  });
  await act(async () => {
    pauseAttemptDetailPolling("pause-test");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(21000);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  expect(result.current.data?.attempt.status).toBe("draft");
  expect(vi.mocked(fetchAttemptApi).mock.calls.length).toBe(count);
  await act(async () => {
    resumeAttemptDetailPolling("pause-test");
    await client.invalidateQueries({
      queryKey: studentAttemptKey("pause-test"),
    });
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data?.attempt.status).toBe("submitted");
  unmount();
  client.clear();
});

it("暂停前已在途的详情响应不能把末题阅读切到整卷结果", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(studentAttemptKey("pause-test"), draft);
  let resolveRead: ((value: AttemptDraftData) => void) | undefined;
  vi.mocked(fetchAttemptApi).mockImplementation(
    () =>
      new Promise<AttemptDraftData>((resolve) => {
        resolveRead = resolve;
      }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useAttemptDetail("pause-test"), {
    wrapper,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  await act(async () => {
    pauseAttemptDetailPolling("pause-test");
    resolveRead?.({
      ...draft,
      attempt: { ...draft.attempt, status: "submitted" },
    });
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data?.attempt.status).toBe("draft");
  unmount();
  client.clear();
});

it("详情超时不自动再等一轮，显式重试建立新读取", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1, retryDelay: 1 } },
  });
  vi.mocked(fetchAttemptApi)
    .mockRejectedValueOnce(new AttemptDetailReadTimeoutError())
    .mockResolvedValue(draft);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useAttemptDetail("pause-test"), {
    wrapper,
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(vi.mocked(fetchAttemptApi)).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.data).toEqual(draft));
  expect(vi.mocked(fetchAttemptApi)).toHaveBeenCalledTimes(2);
  unmount();
  client.clear();
});

it("切换 attempt 时取消旧读取，迟到旧结果不能覆盖新卷", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let resolveOld: ((value: AttemptDraftData) => void) | undefined;
  vi.mocked(fetchAttemptApi).mockImplementation((attemptId) =>
    attemptId === "old"
      ? new Promise<AttemptDraftData>((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({
          ...draft,
          attempt: { ...draft.attempt, id: "new" },
        }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(
    ({ attemptId }) => useAttemptDetail(attemptId),
    { initialProps: { attemptId: "old" }, wrapper },
  );
  await waitFor(() =>
    expect(vi.mocked(fetchAttemptApi)).toHaveBeenCalledWith(
      "old",
      expect.any(AbortSignal),
    ),
  );
  const oldSignal = vi.mocked(fetchAttemptApi).mock.calls[0]?.[1];
  rerender({ attemptId: "new" });
  await waitFor(() => expect(result.current.data?.attempt.id).toBe("new"));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    resolveOld?.({ ...draft, attempt: { ...draft.attempt, id: "old" } });
  });
  expect(result.current.data?.attempt.id).toBe("new");
  expect(client.getQueryData(studentAttemptKey("old"))).toBeUndefined();
  unmount();
  client.clear();
});

it("账号缓存清理后，同一详情键的旧响应不能覆盖新账号读取", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let resolveOld: ((value: AttemptDraftData) => void) | undefined;
  vi.mocked(fetchAttemptApi)
    .mockImplementationOnce(
      () =>
        new Promise<AttemptDraftData>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({
      ...draft,
      attempt: { ...draft.attempt, id: "pause-test", attemptNo: 2 },
    });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const old = renderHook(() => useAttemptDetail("pause-test"), { wrapper });
  await waitFor(() =>
    expect(vi.mocked(fetchAttemptApi)).toHaveBeenCalledTimes(1),
  );
  const oldSignal = vi.mocked(fetchAttemptApi).mock.calls[0]?.[1];
  old.unmount();
  await clearAccountQueries(client, "student");
  expect(oldSignal?.aborted).toBe(true);
  const fresh = renderHook(() => useAttemptDetail("pause-test"), { wrapper });
  await waitFor(() =>
    expect(fresh.result.current.data?.attempt.attemptNo).toBe(2),
  );
  await act(async () => {
    resolveOld?.(draft);
  });
  expect(fresh.result.current.data?.attempt.attemptNo).toBe(2);
  expect(
    client.getQueryData<AttemptDraftData>(studentAttemptKey("pause-test"))
      ?.attempt.attemptNo,
  ).toBe(2);
  fresh.unmount();
  client.clear();
});
