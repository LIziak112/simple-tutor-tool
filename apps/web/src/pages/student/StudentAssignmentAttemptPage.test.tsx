import { fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  AttemptDraftData,
  AttemptResultData,
  AttemptStartData,
  StudentAnswer,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAttemptApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  submitAttemptApi,
} from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAssignmentAttemptPage from "./StudentAssignmentAttemptPage";

/**
 * 答题页整页流程测试（T2.6，API 层 mock）：
 * - 进入自动 POST attempt → 草稿视图渲染题卡与吸底进度条；
 * - 作答触发草稿保存（判断题立即保存）；
 * - 交卷确认弹层显示未答数量 → 确认后 submit → 详情失效重取 → 切结果视图；
 * - attempt 已交卷时进入直接渲染结果视图（不开新卷）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startAttemptApi: vi.fn(),
    fetchAttemptApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    submitAttemptApi: vi.fn(),
  };
});

const mockedStart = vi.mocked(startAttemptApi);
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedSave = vi.mocked(saveAttemptAnswerApi);
const mockedSubmit = vi.mocked(submitAttemptApi);

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

const START_DRAFT: AttemptStartData = {
  id: ATTEMPT_ID,
  assignmentId: ASSIGNMENT_ID,
  unitId: "练习四",
  status: "draft",
  startedAt: "2026-09-27T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};

const DRAFT_DATA: AttemptDraftData = {
  attempt: START_DRAFT,
  title: "周末加练",
  dueAt: "2026-10-01T12:00:00.000Z",
  questions: [
    {
      id: "练习四-1",
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
      stemMd: "$0$ 既不是正数，也不是负数。[[]]",
      hintCount: 0,
    },
    {
      id: "练习四-4",
      type: "fill",
      difficulty: 2,
      knowledge: ["有理数加法"],
      stemMd: "计算：$(-3)+7=$ [[]]。",
      hintCount: 1,
    },
  ],
  drafts: {},
};

const RESULT_DATA: AttemptResultData = {
  attempt: {
    ...START_DRAFT,
    status: "submitted",
    submittedAt: "2026-09-27T02:30:00.000Z",
    scoreAuto: 100,
  },
  title: "周末加练",
  dueAt: "2026-10-01T12:00:00.000Z",
  summary: {
    total: 2,
    answered: 2,
    correct: 2,
    wrong: 0,
    pending: 0,
    unanswered: 0,
    autoGradable: 2,
  },
  questions: [
    {
      questionId: "练习四-1",
      snapshot: {
        id: "练习四-1",
        type: "judge",
        difficulty: 1,
        knowledge: ["有理数的概念"],
        stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
        hintCount: 0,
      },
      answers: { kind: "judge", value: true },
      solutionMd: null,
      answer: { kind: "judge", value: true },
      autoCorrect: true,
    },
    {
      questionId: "练习四-4",
      snapshot: {
        id: "练习四-4",
        type: "fill",
        difficulty: 2,
        knowledge: ["有理数加法"],
        stemMd: "计算：$(-3)+7=$ [[4]]。",
        hintCount: 1,
      },
      answers: { kind: "fill", blanks: [["4"]] },
      solutionMd: null,
      answer: { kind: "fill", values: ["4"] },
      autoCorrect: true,
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/assignments/${ASSIGNMENT_ID}`,
    routePath: "/s/assignments/:id",
    element: <StudentAssignmentAttemptPage />,
  });
}

beforeEach(() => {
  mockedStart.mockReset();
  mockedFetch.mockReset();
  mockedSave.mockReset();
  mockedSubmit.mockReset();
});

describe("StudentAssignmentAttemptPage：草稿作答流程", () => {
  it("进入自动创建 attempt 并渲染题卡、进度条与截止时间", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    renderPage();

    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(mockedStart).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("第 2 题")).toBeInTheDocument();
    // 进度条文本含 <b> 强调，用整页文本断言
    expect(document.body.textContent).toContain("已答 0 / 2 题");
    expect(screen.getByText("10月1日 20:00 截止")).toBeInTheDocument();
  });

  it("作答即保存：点判断题「对」立即 PUT 草稿，进度条更新", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1", {
        kind: "judge",
        value: true,
      } satisfies StudentAnswer);
    });
    expect(document.body.textContent).toContain("已答 1 / 2 题");
  });

  it("交卷确认显示未答数量；确认后 submit 并切结果视图", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    // 第一次取详情=草稿，交卷失效后重取=结果
    mockedFetch
      .mockResolvedValueOnce(DRAFT_DATA)
      .mockResolvedValue(RESULT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "交卷" }));
    expect(
      await screen.findByText("还有 1 题没有作答，交卷后不能再修改答案。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledWith(ATTEMPT_ID));
    // 详情已失效重取 → 结果视图
    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "交卷" })).toBeNull();
  });

  it("attempt 创建失败显示错误态与重试", async () => {
    mockedStart.mockRejectedValue(new Error("未被指派此作业，无权作答"));
    renderPage();

    expect(await screen.findByText("打不开这份作业")).toBeInTheDocument();
    expect(screen.getByText("未被指派此作业，无权作答")).toBeInTheDocument();
    // 重试重新发起
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("周末加练");
  });
});

describe("StudentAssignmentAttemptPage：已交卷直接结果视图", () => {
  it("startAttempt 返回 submitted 时不开新卷，直接渲染结果", async () => {
    mockedStart.mockResolvedValue(RESULT_DATA.attempt);
    mockedFetch.mockResolvedValue(RESULT_DATA);
    renderPage();

    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    // 答题控件不出现
    expect(screen.queryByRole("radio", { name: /对/ })).toBeNull();
  });
});
