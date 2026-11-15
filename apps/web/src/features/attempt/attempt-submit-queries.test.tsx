import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttemptDetailData } from "@tutor/contract";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchAttemptApi, submitAttemptApi } from "@/lib/api";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { useSubmitAttempt } from "./attempt-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const api = await importOriginal<typeof import("@/lib/api")>();
  return { ...api, fetchAttemptApi: vi.fn(), submitAttemptApi: vi.fn() };
});

beforeEach(() => vi.resetAllMocks());

const ATTEMPT_ID = "f905b7be-a9b7-491b-8537-b003265136ca";

function renderSubmit() {
  const client = new QueryClient();
  const hook = renderHook(() => useSubmitAttempt(ATTEMPT_ID), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}

const summary = {
  id: ATTEMPT_ID,
  sourceType: "wrong" as const,
  assignmentId: null,
  courseId: null,
  lectureId: null,
  unitId: null,
  attemptNo: 1,
  startedAt: "2026-10-01T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const shared = {
  title: "练习",
  courseName: null,
  dueAt: null,
  units: [],
  enabledCapabilities: [],
};
const draft: AttemptDetailData = {
  ...shared,
  attempt: { ...summary, status: "draft" },
  answerRelease: "on_submit",
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
};
const result: AttemptDetailData = {
  ...shared,
  attempt: { ...summary, status: "graded", submittedAt: summary.startedAt },
  answersReleased: true,
  summary: {
    total: 0,
    answered: 0,
    correct: 0,
    wrong: 0,
    pending: 0,
    unanswered: 0,
    autoGradable: 0,
    scoreFinal: null,
    pendingCount: 0,
  },
};
const request = { revisions: [] };

it("提交回执丢失后读取已交卷结果，只发送一次交卷请求", async () => {
  vi.mocked(submitAttemptApi).mockRejectedValueOnce(new Error("交卷超时"));
  vi.mocked(fetchAttemptApi).mockResolvedValueOnce(result);
  const hook = renderSubmit();
  await act(async () => {
    await expect(hook.result.current.mutateAsync(request)).resolves.toEqual(
      result,
    );
  });
  expect(submitAttemptApi).toHaveBeenCalledTimes(1);
  expect(fetchAttemptApi).toHaveBeenCalledWith(ATTEMPT_ID);
  expect(hook.client.getQueryData(["student", "attempt", ATTEMPT_ID])).toEqual(
    result,
  );
});

it("核对失败时下一次操作仅核对，服务端确认仍为草稿后才允许再次提交", async () => {
  vi.mocked(submitAttemptApi).mockRejectedValueOnce(new Error("交卷超时"));
  vi.mocked(fetchAttemptApi)
    .mockRejectedValueOnce(new Error("读取失败"))
    .mockResolvedValueOnce(draft);
  const hook = renderSubmit();
  await act(async () => {
    await expect(hook.result.current.mutateAsync(request)).rejects.toThrow(
      "重新核对",
    );
  });
  await waitFor(() =>
    expect(hook.result.current.verificationRequired).toBe(true),
  );
  hook.unmount();
  const reopened = renderSubmit();
  expect(reopened.result.current.verificationRequired).toBe(true);
  await act(async () => {
    await expect(reopened.result.current.mutateAsync(request)).rejects.toThrow(
      "尚未交卷",
    );
  });
  await waitFor(() =>
    expect(reopened.result.current.verificationRequired).toBe(false),
  );
  expect(submitAttemptApi).toHaveBeenCalledTimes(1);
  expect(fetchAttemptApi).toHaveBeenCalledTimes(2);
});
