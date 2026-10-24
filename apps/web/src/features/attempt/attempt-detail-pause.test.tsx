import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { AttemptDraftData } from "@tutor/contract";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAttemptApi } from "@/lib/api";
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
    courseId: null,
    unitId: null,
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
