import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewPreviewData,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiAttemptReviewApi,
  createStudentAiBatchReviewApi,
  fetchStudentAiAttemptReviewDetailApi,
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import {
  AttemptReviewHost,
  useAttemptReviewOverlay,
} from "./AttemptReviewHost";
import { AttemptReviewTopBarEntry } from "./AttemptReviewTopBarEntry";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listStudentAiAttemptReviewsApi: vi.fn(),
    fetchStudentAiAttemptReviewPreviewApi: vi.fn(),
    fetchStudentAiAttemptReviewDetailApi: vi.fn(),
    postStudentAiAttemptReviewActionApi: vi.fn(),
    createStudentAiAttemptReviewApi: vi.fn(),
    createStudentAiBatchReviewApi: vi.fn(),
  };
});

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const mockedList = vi.mocked(listStudentAiAttemptReviewsApi);
const mockedPreview = vi.mocked(fetchStudentAiAttemptReviewPreviewApi);
const mockedDetail = vi.mocked(fetchStudentAiAttemptReviewDetailApi);
const mockedAction = vi.mocked(postStudentAiAttemptReviewActionApi);
const mockedCreate = vi.mocked(createStudentAiAttemptReviewApi);
const mockedBatchCreate = vi.mocked(createStudentAiBatchReviewApi);

const taskOf = (
  overrides: Partial<AiAttemptReviewTaskPublic> = {},
): AiAttemptReviewTaskPublic => ({
  id: TASK_ID,
  attemptId: ATTEMPT_ID,
  status: "replied",
  purpose: "复盘",
  questionCount: 27,
  counts: {
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
  },
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
  ...overrides,
});

const PREVIEW: AiAttemptReviewPreviewData = {
  attemptId: ATTEMPT_ID,
  questionCount: 27,
  counts: taskOf().counts,
  fieldNotes: [],
  notes: [],
  opaquePreviewVersion: "pv-1",
  readyAt: "2026-11-12T17:00:00.000Z",
};

const DETAIL: AiAttemptReviewDetailData = {
  task: taskOf(),
  result: {
    schemaVersion: 1,
    overview: "整体基础扎实。",
    knowledgeFindings: [
      {
        statement: "函数图像平移不稳",
        evidenceQuestionNos: [8],
        basis: "platform_fact",
        confidence: "high",
      },
    ],
    errorPatterns: [],
    performanceNotes: [],
    trainingPlan: [],
    limitations: [],
  },
};

const onJumpToQuestion = vi.fn();

function Harness() {
  const overlay = useAttemptReviewOverlay();
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.search}</output>
      <AttemptReviewTopBarEntry
        attemptId={ATTEMPT_ID}
        released
        onOpen={overlay.open}
      />
      <AttemptReviewHost
        attemptId={ATTEMPT_ID}
        released
        attemptLabel="期中模拟卷 · 第 2 次"
        overlay={overlay}
        onJumpToQuestion={onJumpToQuestion}
      />
    </>
  );
}

function renderAt(search: string) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/s/attempts/${ATTEMPT_ID}${search}`]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const searchNow = () => screen.getByTestId("location").textContent;

beforeEach(() => {
  for (const mock of [
    mockedList,
    mockedPreview,
    mockedDetail,
    mockedAction,
    mockedCreate,
    mockedBatchCreate,
    onJumpToQuestion,
  ])
    mock.mockReset();
  mockedAction.mockResolvedValue(taskOf({ openedAt: "2026-11-12T18:00:00Z" }));
});

describe("整卷复盘承载：地址驱动", () => {
  it("带 aiReview=<任务 id> 进入：直接打开这份报告；关闭后去掉参数、保留其余位置", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt(`?reviewQuestion=q-3&aiReview=${TASK_ID}&aiFrom=%2Fs%2Fhome`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    expect(mockedDetail).toHaveBeenCalledWith(TASK_ID);
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?reviewQuestion=q-3&aiFrom=%2Fs%2Fhome");
  });

  it("顶栏「查看整卷复盘报告」与地址进入打开的是同一份报告", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt("");
    fireEvent.click(
      await screen.findByRole("button", { name: /查看整卷复盘报告/ }),
    );
    expect(searchNow()).toBe(`?aiReview=${TASK_ID}`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
  });

  it("看进度只读：打开面板不取报告正文、不记已读；从面板可转去看报告", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt("?aiReview=panel");
    const panel = await screen.findByRole("dialog", { name: "整卷复盘" });
    expect(panel).toBeInTheDocument();
    const openReport = await screen.findAllByRole("button", {
      name: /查看整卷复盘报告/,
    });
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedAction).not.toHaveBeenCalled();
    // 只会查到面板内的按钮：顶栏入口此刻被弹层遮住，不在可访问树里
    expect(openReport).toHaveLength(1);
    const inPanel = openReport[0];
    if (inPanel === undefined) throw new Error("面板内缺少查看报告按钮");
    fireEvent.click(inPanel);
    expect(searchNow()).toBe(`?aiReview=${TASK_ID}`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockedAction).toHaveBeenCalledWith(TASK_ID, "open"),
    );
  });

  it("首次发起：确认后只发 1 次整卷任务创建请求，不创建任何逐题任务", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    mockedCreate.mockResolvedValue({
      task: taskOf({ status: "created", hasResult: false }),
      created: true,
    });
    renderAt("");
    fireEvent.click(await screen.findByRole("button", { name: "整卷复盘" }));
    expect(searchNow()).toBe("?aiReview=panel");
    expect(
      await screen.findByText(/确认后只创建 1 条整卷任务/),
    ).toBeInTheDocument();
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "created", hasResult: false })],
      nextCursor: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "确认发起整卷复盘（27 题）" }),
    );
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        channel: "mcp",
        expectedPreviewVersion: "pv-1",
      }),
    );
    expect(mockedBatchCreate).not.toHaveBeenCalled();
    // 顶栏入口随即改报进度（此刻被面板遮住，按隐藏元素查）
    expect(
      await screen.findByRole("button", {
        name: "整卷复盘 · 等待领取",
        hidden: true,
      }),
    ).toBeInTheDocument();
  });

  it("点证据题号：先关报告再定位到那道题", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt(`?aiReview=${TASK_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "第 8 题" }));
    await waitFor(() => expect(onJumpToQuestion).toHaveBeenCalledWith(8));
    expect(searchNow()).toBe("");
    expect(screen.queryByText("整体基础扎实。")).toBeNull();
    expect(onJumpToQuestion).toHaveBeenCalledTimes(1);
  });
});
