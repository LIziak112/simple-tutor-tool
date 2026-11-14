import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, postStudentAiAttemptReviewActionApi } from "@/lib/api";
import { fetchStudentAiAttemptReviewDetailApi } from "@/lib/review-queue-legacy-api";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test/render-with-portal";
import { AttemptReviewReportReader } from "./AttemptReviewReportReader";
import { attemptReviewDetailKey } from "./attempt-review-entry";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    postStudentAiAttemptReviewActionApi: vi.fn(),
  };
});
vi.mock("@/lib/review-queue-legacy-api", () => ({
  fetchStudentAiAttemptReviewDetailApi: vi.fn(),
}));

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const mockedDetail = vi.mocked(fetchStudentAiAttemptReviewDetailApi);
const mockedAction = vi.mocked(postStudentAiAttemptReviewActionApi);

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

const REPORT: NonNullable<AiAttemptReviewDetailData["result"]> = {
  schemaVersion: 1,
  overview: "整体基础扎实，失分集中在函数图像。",
  knowledgeFindings: [
    {
      statement: "二次函数图像平移掌握不稳",
      evidenceQuestionNos: [8, 11],
      basis: "platform_fact",
      confidence: "high",
    },
  ],
  errorPatterns: [
    {
      statement: "读题漏掉取值范围",
      evidenceQuestionNos: [14],
      basis: "ai_hypothesis",
      confidence: "medium",
    },
  ],
  performanceNotes: [],
  trainingPlan: [
    {
      knowledgePoint: "二次函数",
      relatedQuestionNos: [8],
      action: "重做平移类题目三道",
      priority: "high",
      caveat: "先看课本例题",
    },
  ],
  limitations: ["没有作答过程数据"],
};

const detailOf = (
  task: AiAttemptReviewTaskPublic = taskOf(),
  result: AiAttemptReviewDetailData["result"] = REPORT,
): AiAttemptReviewDetailData => ({
  task,
  result,
  questionIds:
    result === null
      ? []
      : Array.from({ length: 27 }, (_, index) => `q-${index + 1}`),
});

function renderReader(client = new QueryClient()) {
  const onClose = vi.fn();
  const onJumpToQuestion = vi.fn();
  const onOpenPanel = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AttemptReviewReportReader
          attemptId={ATTEMPT_ID}
          taskId={TASK_ID}
          attemptLabel="期中模拟卷 · 第 2 次"
          onClose={onClose}
          onJumpToQuestion={onJumpToQuestion}
          onOpenPanel={onOpenPanel}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, onClose, onJumpToQuestion, onOpenPanel };
}

beforeEach(() => {
  mockedDetail.mockReset();
  mockedAction.mockReset();
  mockedAction.mockResolvedValue(taskOf({ openedAt: "2026-11-12T18:00:00Z" }));
});

describe("整卷复盘报告阅读器", () => {
  it("正文渲染后才记已读，且只记一次；头部写明是哪份卷的哪一次", async () => {
    mockedDetail.mockResolvedValue(detailOf());
    renderReader();
    expect(mockedAction).not.toHaveBeenCalled();
    expect(
      await screen.findByText("整体基础扎实，失分集中在函数图像。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "整卷复盘报告" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/期中模拟卷 · 第 2 次/)).toBeInTheDocument();
    expect(screen.getByText(/覆盖 27 题/)).toBeInTheDocument();
    expect(screen.getByText("二次函数图像平移掌握不稳")).toBeInTheDocument();
    expect(screen.getByText("重做平移类题目三道")).toBeInTheDocument();
    expect(screen.getByText("没有作答过程数据")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockedAction).toHaveBeenCalledWith(TASK_ID, "open"),
    );
    expect(mockedAction).toHaveBeenCalledTimes(1);
  });

  it("事实与推测分开标注，不把模型假设呈现成平台事实", async () => {
    mockedDetail.mockResolvedValue(detailOf());
    renderReader();
    await screen.findByText("二次函数图像平移掌握不稳");
    expect(screen.getByText("平台事实")).toBeInTheDocument();
    expect(screen.getByText("AI 推测")).toBeInTheDocument();
  });

  it("已读过的报告再打开：不重复记已读", async () => {
    mockedDetail.mockResolvedValue(
      detailOf(taskOf({ openedAt: "2026-11-12T18:00:00.000Z" })),
    );
    renderReader();
    await screen.findByText("整体基础扎实，失分集中在函数图像。");
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("服务端拒绝（答案撤回公布 / 教学授权收回）：不显示正文，不记已读", async () => {
    mockedDetail.mockRejectedValue(
      new ApiError("AI_NOT_ALLOWED", "老师暂未开放这份练习的 AI 复盘", 403),
    );
    renderReader();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "老师暂未开放这份练习的 AI 复盘",
    );
    expect(screen.queryByText("整体基础扎实，失分集中在函数图像。")).toBeNull();
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("读过之后权限被收回：重新核对失败即收起正文（不拿旧缓存继续展示）", async () => {
    mockedDetail.mockResolvedValue(
      detailOf(taskOf({ openedAt: "2026-11-12T18:00:00.000Z" })),
    );
    const { client } = renderReader();
    await screen.findByText("整体基础扎实，失分集中在函数图像。");
    mockedDetail.mockRejectedValue(
      new ApiError("AI_NOT_ALLOWED", "老师暂未开放这份练习的 AI 复盘", 403),
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: attemptReviewDetailKey(TASK_ID),
      });
    });
    await waitFor(() =>
      expect(
        screen.queryByText("整体基础扎实，失分集中在函数图像。"),
      ).toBeNull(),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("关闭后重开遇到撤权：上一轮迟到的正文不可显示或记已读", async () => {
    const client = new QueryClient();
    const oldResponse = Promise.withResolvers<AiAttemptReviewDetailData>();
    mockedDetail
      .mockReturnValueOnce(oldResponse.promise)
      .mockRejectedValue(
        new ApiError("AI_POLICY_DISABLED", "本次练习的复盘权限已撤回", 403),
      );
    const first = renderReader(client);
    await waitFor(() => expect(mockedDetail).toHaveBeenCalledTimes(1));
    const firstSignal = mockedDetail.mock.calls[0]?.[1];
    first.unmount();
    expect(firstSignal?.aborted).toBe(true);
    renderReader(client);

    await act(async () => oldResponse.resolve(detailOf()));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "复盘权限已撤回",
    );
    expect(mockedDetail).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(REPORT.overview)).not.toBeInTheDocument();
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("离线重开时不渲染尚未清除的正文，联网后重新核对", async () => {
    const client = new QueryClient();
    client.setQueryData(attemptReviewDetailKey(TASK_ID), detailOf());
    mockedDetail.mockRejectedValue(
      new ApiError("AI_POLICY_DISABLED", "本次练习的复盘权限已撤回", 403),
    );
    onlineManager.setOnline(false);
    try {
      renderReader(client);
      expect(screen.getByRole("status")).toHaveTextContent("当前离线");
      expect(screen.queryByText(REPORT.overview)).not.toBeInTheDocument();
      expect(mockedDetail).not.toHaveBeenCalled();
      await act(async () => onlineManager.setOnline(true));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "复盘权限已撤回",
      );
      expect(mockedAction).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("报告属于另一次作答：不显示正文、不记已读，给出去对应作答结果的入口", async () => {
    mockedDetail.mockResolvedValue(
      detailOf(taskOf({ attemptId: OTHER_ATTEMPT_ID })),
    );
    renderReader();
    const link = await screen.findByRole("link", {
      name: "前往对应的作答结果",
    });
    expect(link).toHaveAttribute(
      "href",
      `/s/attempts/${OTHER_ATTEMPT_ID}?aiReview=${TASK_ID}`,
    );
    expect(screen.queryByText("整体基础扎实，失分集中在函数图像。")).toBeNull();
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("报告还没生成：如实报状态，可转去看进度，不记已读", async () => {
    mockedDetail.mockResolvedValue(
      detailOf(taskOf({ status: "claimed", hasResult: false }), null),
    );
    const { onOpenPanel } = renderReader();
    expect(await screen.findByText(/报告还没生成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看进度" }));
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("点证据题号回到那道题；底部按钮关闭回到作答结果", async () => {
    mockedDetail.mockResolvedValue(detailOf());
    const { onJumpToQuestion, onClose } = renderReader();
    await screen.findByText("读题漏掉取值范围");
    fireEvent.click(screen.getByRole("button", { name: "第 14 题" }));
    expect(onJumpToQuestion).toHaveBeenCalledWith("q-14");
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
