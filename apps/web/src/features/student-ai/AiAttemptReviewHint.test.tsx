import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type {
  AiAttemptReviewPreviewData,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
} from "@/lib/api";
import {
  AiAttemptReviewHint,
  pickAttemptReviewTask,
} from "./AiAttemptReviewHint";

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

function renderHint(released = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiAttemptReviewHint attemptId={ATTEMPT_ID} released={released} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPreview.mockReset();
});

describe("结果页「可复盘」提示条", () => {
  it("无任务且预览可用 → 「本卷可复盘」+ 预览并确认", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    renderHint();
    const hint = await screen.findByTestId("attempt-review-hint");
    expect(hint.textContent).toContain("本卷可复盘：共 12 题、已判 11 题");
    expect(
      screen.getByRole("button", { name: "预览并确认" }),
    ).toBeInTheDocument();
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

  it("有进行中任务 → 报进度，不再请求预览", async () => {
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "claimed" })],
      nextCursor: null,
    });
    renderHint();
    const hint = await screen.findByTestId("attempt-review-hint");
    expect(hint.textContent).toContain(
      "整体复盘进行中：外部 AI 处理中（覆盖 12 题）",
    );
    expect(
      screen.getByRole("button", { name: "查看进度" }),
    ).toBeInTheDocument();
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("报告已到未读 → 高亮「还没看过」；已读 → 「可再看一次」", async () => {
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "replied", hasResult: true })],
      nextCursor: null,
    });
    const view = renderHint();
    expect(
      (await screen.findByTestId("attempt-review-hint")).textContent,
    ).toContain("整体复盘报告已到，还没看过");
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
    ).toContain("整体复盘已完成，可再看一次报告");
  });

  it("未公布 → 不请求、不渲染", () => {
    renderHint(false);
    expect(mockedList).not.toHaveBeenCalled();
    expect(screen.queryByTestId("attempt-review-hint")).toBeNull();
  });

  it("pickAttemptReviewTask：活动任务优先；其余有结局的按创建时间最新优先（#102-03 新失败 / 暂停不被旧报告盖住）；取消与归档不计", () => {
    const oldReplied = taskOf({
      id: "b",
      status: "replied",
      createdAt: "2026-11-09T10:00:00.000Z",
    });
    const newerPaused = taskOf({
      id: "a",
      status: "paused",
      createdAt: "2026-11-09T11:00:00.000Z",
    });
    const newerFailed = taskOf({
      id: "f",
      status: "failed",
      createdAt: "2026-11-09T11:30:00.000Z",
    });
    const created = taskOf({
      id: "c",
      status: "created",
      createdAt: "2026-11-09T09:00:00.000Z",
    });
    const cancelled = taskOf({ id: "d", status: "cancelled" });
    const archived = taskOf({
      id: "e",
      status: "replied",
      archivedAt: "2026-11-09T12:00:00.000Z",
      createdAt: "2026-11-09T12:00:00.000Z",
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
          createdAt: "2026-11-09T08:00:00.000Z",
        }),
        oldReplied,
      ])?.id,
    ).toBe("b");
    expect(pickAttemptReviewTask([newerPaused])?.id).toBe("a");
    expect(pickAttemptReviewTask([cancelled, archived])).toBeUndefined();
  });
});
