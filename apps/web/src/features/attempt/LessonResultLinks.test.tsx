import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { AiAttemptReviewTaskPublic } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LessonResultLinks } from "@/features/attempt/LessonResultLinks";
import {
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
} from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listStudentAiAttemptReviewsApi: vi.fn(),
    fetchStudentAiAttemptReviewPreviewApi: vi.fn(),
  };
});

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const mockedList = vi.mocked(listStudentAiAttemptReviewsApi);
const mockedPreview = vi.mocked(fetchStudentAiAttemptReviewPreviewApi);

const COUNTS: AiAttemptReviewTaskPublic["counts"] = {
  total: 27,
  correctCount: 20,
  incorrectCount: 6,
  unansweredCount: 1,
  pendingCount: 0,
  unknownAnswerCount: 0,
  hasAnswerCount: 26,
  missingAnswerCount: 1,
  gradedCount: 26,
  accuracyAmongGraded: 20 / 26,
};

const repliedTask: AiAttemptReviewTaskPublic = {
  id: TASK_ID,
  attemptId: ATTEMPT_ID,
  status: "replied",
  purpose: "复盘",
  questionCount: 27,
  counts: COUNTS,
  snapshotVersion: "v",
  generation: 1,
  retryCount: 0,
  errorText: null,
  hasResult: true,
  openedAt: null,
  archivedAt: null,
  allowedActions: ["open", "archive"],
  createdAt: "2026-11-12T17:11:55.000Z",
  updatedAt: "2026-11-12T17:20:00.000Z",
};

function renderLinks() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <LessonResultLinks attemptId={ATTEMPT_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPreview.mockReset();
});

describe("讲练完成页：结果与整卷复盘入口", () => {
  it("可发起：「查看结果」旁直接有「整卷复盘」，一步进入结果页的发起面板", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue({
      attemptId: ATTEMPT_ID,
      questionCount: 27,
      counts: COUNTS,
      fieldNotes: [],
      notes: [],
      opaquePreviewVersion: "pv",
      readyAt: "2026-11-12T17:00:00.000Z",
    });
    renderLinks();
    expect(screen.getByRole("link", { name: "查看结果" })).toHaveAttribute(
      "href",
      `/s/attempts/${ATTEMPT_ID}`,
    );
    expect(
      await screen.findByRole("link", { name: "整卷复盘" }),
    ).toHaveAttribute("href", `/s/attempts/${ATTEMPT_ID}?aiReview=panel`);
  });

  it("报告已出：入口变「查看整卷复盘报告」，直达这份报告", async () => {
    mockedList.mockResolvedValue({ tasks: [repliedTask], nextCursor: null });
    renderLinks();
    expect(
      await screen.findByRole("link", { name: /查看整卷复盘报告/ }),
    ).toHaveAttribute("href", `/s/attempts/${ATTEMPT_ID}?aiReview=${TASK_ID}`);
  });

  it("服务端未放行：只有「查看结果」，不出现整卷复盘入口", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockRejectedValue(new Error("当前不可复盘"));
    renderLinks();
    await waitFor(() => expect(mockedPreview).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "查看结果" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /整卷复盘/ })).toBeNull();
  });
});
