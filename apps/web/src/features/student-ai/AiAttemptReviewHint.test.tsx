import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AiAttemptReviewPreviewData,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
} from "@/lib/api";
import { AiAttemptReviewHint } from "./AiAttemptReviewHint";
import {
  ATTEMPT_REVIEW_POLL_INTERVAL_MS,
  attemptReviewPreviewKey,
  pickAttemptReviewTask,
} from "./attempt-review-entry";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listStudentAiAttemptReviewsApi: vi.fn(),
    fetchStudentAiAttemptReviewPreviewApi: vi.fn(),
  };
});

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const mockedList = vi.mocked(listStudentAiAttemptReviewsApi);
const mockedPreview = vi.mocked(fetchStudentAiAttemptReviewPreviewApi);

const taskOf = (
  overrides: Partial<AiAttemptReviewTaskPublic>,
): AiAttemptReviewTaskPublic => ({
  id: "22222222-2222-4222-8222-222222222222",
  attemptId: ATTEMPT_ID,
  status: "created",
  purpose: "复盘",
  questionCount: 12,
  counts: {
    total: 12,
    correctCount: 8,
    incorrectCount: 3,
    unansweredCount: 1,
    pendingCount: 0,
    unknownAnswerCount: 0,
    hasAnswerCount: 11,
    missingAnswerCount: 1,
    gradedCount: 11,
    accuracyAmongGraded: 8 / 11,
  },
  snapshotVersion: "v",
  generation: 0,
  retryCount: 0,
  errorText: null,
  hasResult: false,
  openedAt: null,
  archivedAt: null,
  allowedActions: [],
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  ...overrides,
});

const PREVIEW: AiAttemptReviewPreviewData = {
  attemptId: ATTEMPT_ID,
  questionCount: 12,
  counts: taskOf({}).counts,
  fieldNotes: [],
  notes: [],
  opaquePreviewVersion: "pv",
  readyAt: "2026-11-09T10:00:00.000Z",
};

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const onOpen = vi.fn();

function renderHint(released = true, client = newClient()) {
  return render(
    <QueryClientProvider client={client}>
      <AiAttemptReviewHint
        attemptId={ATTEMPT_ID}
        released={released}
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPreview.mockReset();
  onOpen.mockReset();
});

describe("结果页「可复盘」提示条", () => {
  it("无任务且预览可用 → 「本卷可以做整卷复盘」+ 预览并确认（打开发起面板）", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    renderHint();
    const hint = await screen.findByTestId("attempt-review-hint");
    expect(hint.textContent).toContain(
      "本卷可以做整卷复盘：共 12 题、已判 11 题",
    );
    fireEvent.click(screen.getByRole("button", { name: "预览并确认" }));
    expect(onOpen).toHaveBeenCalledWith("panel");
  });

  it("预览被服务端拒绝（未满足可用门）→ 不渲染，不猜", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockRejectedValue(
      new ApiError("AI_ATTEMPT_REVIEW_NOT_AVAILABLE", "当前不可复盘", 403),
    );
    renderHint();
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("attempt-review-hint")).toBeNull();
  });

  it("#102-02 预览重取被拒绝：缓存里虽留有上次数据，也不再提示可复盘", async () => {
    const client = newClient();
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    renderHint(true, client);
    expect(
      (await screen.findByTestId("attempt-review-hint")).textContent,
    ).toContain("本卷可以做整卷复盘");
    // 教师收紧策略：后台重取被服务端拒绝
    mockedPreview.mockRejectedValue(
      new ApiError("AI_ATTEMPT_REVIEW_NOT_AVAILABLE", "当前不可复盘", 403),
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: attemptReviewPreviewKey(ATTEMPT_ID),
      });
    });
    expect(mockedPreview).toHaveBeenCalledTimes(2);
    // TanStack v5：重取失败 status=error 但保留上次 data——提示条不能只看 data
    expect(client.getQueryData(attemptReviewPreviewKey(ATTEMPT_ID))).toEqual(
      PREVIEW,
    );
    await waitFor(() =>
      expect(screen.queryByTestId("attempt-review-hint")).toBeNull(),
    );
  });

  it("有进行中任务 → 报进度，不再请求预览", async () => {
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "claimed" })],
      nextCursor: null,
    });
    renderHint();
    const hint = await screen.findByTestId("attempt-review-hint");
    expect(hint.textContent).toContain("整卷复盘进行中：处理中（覆盖 12 题）");
    fireEvent.click(screen.getByRole("button", { name: "查看进度" }));
    expect(onOpen).toHaveBeenCalledWith("panel");
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("报告已到未读 → 高亮「还没看过」；已读 → 仍可再打开；按钮直达这份报告", async () => {
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "replied", hasResult: true })],
      nextCursor: null,
    });
    const view = renderHint();
    expect(
      (await screen.findByTestId("attempt-review-hint")).textContent,
    ).toContain("整卷复盘报告已生成，还没看过");
    fireEvent.click(screen.getByRole("button", { name: "打开报告" }));
    expect(onOpen).toHaveBeenCalledWith(taskOf({}).id);
    view.unmount();
    mockedList.mockResolvedValue({
      tasks: [
        taskOf({
          status: "replied",
          hasResult: true,
          openedAt: "2026-11-09T11:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });
    renderHint();
    expect(
      (await screen.findByTestId("attempt-review-hint")).textContent,
    ).toContain("整卷复盘报告已看过，可以随时再打开");
    expect(
      screen.getByRole("button", { name: "打开报告" }),
    ).toBeInTheDocument();
  });

  it("未公布 → 不请求、不渲染", () => {
    renderHint(false);
    expect(mockedList).not.toHaveBeenCalled();
    expect(screen.queryByTestId("attempt-review-hint")).toBeNull();
  });

  describe("在途任务轮询（#102-01）", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("等待领取 / 处理中：停留页面时每 15 秒重拉列表，报告到了就改报「已到」并停止轮询", async () => {
      vi.useFakeTimers();
      mockedList.mockResolvedValue({
        tasks: [taskOf({ status: "claimed" })],
        nextCursor: null,
      });
      renderHint();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(screen.getByTestId("attempt-review-hint").textContent).toContain(
        "整卷复盘进行中：处理中",
      );
      expect(mockedList).toHaveBeenCalledTimes(1);
      mockedList.mockResolvedValue({
        tasks: [taskOf({ status: "replied", hasResult: true })],
        nextCursor: null,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ATTEMPT_REVIEW_POLL_INTERVAL_MS + 50);
      });
      expect(mockedList).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("attempt-review-hint").textContent).toContain(
        "整卷复盘报告已生成，还没看过",
      );
      // 有结局后不再轮询
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ATTEMPT_REVIEW_POLL_INTERVAL_MS * 3);
      });
      expect(mockedList).toHaveBeenCalledTimes(2);
    });

    it("无任务（可复盘）时不轮询列表", async () => {
      vi.useFakeTimers();
      mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
      mockedPreview.mockResolvedValue(PREVIEW);
      renderHint();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(screen.getByTestId("attempt-review-hint").textContent).toContain(
        "本卷可以做整卷复盘",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ATTEMPT_REVIEW_POLL_INTERVAL_MS * 3);
      });
      expect(mockedList).toHaveBeenCalledTimes(1);
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    });
  });

  it("pickAttemptReviewTask：活动任务优先；其余有结局的按最近更新优先（#102-03 新失败 / 暂停不被旧报告盖住）；取消与归档不计", () => {
    const at = (iso: string) => ({ createdAt: iso, updatedAt: iso });
    const oldReplied = taskOf({
      id: "b",
      status: "replied",
      ...at("2026-11-09T10:00:00.000Z"),
    });
    const newerPaused = taskOf({
      id: "a",
      status: "paused",
      ...at("2026-11-09T11:00:00.000Z"),
    });
    const newerFailed = taskOf({
      id: "f",
      status: "failed",
      ...at("2026-11-09T11:30:00.000Z"),
    });
    const created = taskOf({
      id: "c",
      status: "created",
      ...at("2026-11-09T09:00:00.000Z"),
    });
    const cancelled = taskOf({ id: "d", status: "cancelled" });
    const archived = taskOf({
      id: "e",
      status: "replied",
      archivedAt: "2026-11-09T12:00:00.000Z",
      ...at("2026-11-09T12:00:00.000Z"),
    });
    // 活动任务即使最早创建也优先
    expect(pickAttemptReviewTask([newerPaused, oldReplied, created])?.id).toBe(
      "c",
    );
    // 旧报告 vs 新暂停 / 新失败：取最新的那次，不让旧报告盖住要处理的状态
    expect(pickAttemptReviewTask([oldReplied, newerPaused])?.id).toBe("a");
    expect(pickAttemptReviewTask([newerFailed, oldReplied])?.id).toBe("f");
    // 新报告 vs 旧失败：同样按最新
    expect(
      pickAttemptReviewTask([
        taskOf({
          id: "g",
          status: "failed",
          ...at("2026-11-09T08:00:00.000Z"),
        }),
        oldReplied,
      ])?.id,
    ).toBe("b");
    expect(pickAttemptReviewTask([newerPaused])?.id).toBe("a");
    expect(pickAttemptReviewTask([cancelled, archived])).toBeUndefined();
    // 重试复用同一任务行（createdAt 不变、updatedAt 刷新）：早创建、后重试出报告的
    // 任务要压过中间那次更早出的报告——按 createdAt 排会把刚到的新报告藏起来
    const retriedReplied = taskOf({
      id: "r",
      status: "replied",
      retryCount: 1,
      createdAt: "2026-11-09T09:30:00.000Z",
      updatedAt: "2026-11-09T13:00:00.000Z",
    });
    expect(pickAttemptReviewTask([oldReplied, retriedReplied])?.id).toBe("r");
  });
});
