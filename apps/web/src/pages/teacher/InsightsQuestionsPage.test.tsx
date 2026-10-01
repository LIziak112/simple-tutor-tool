import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnalyticsQuestionsData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAnalyticsQuestionsApi, fetchTeacherCourses } from "@/lib/api";
import InsightsQuestionsPage from "./InsightsQuestionsPage";

/**
 * /t/insights/questions 题目视角组件测试（T4.2）：三态、表格口径
 * （对率/待批/均时/异常计数）、行展开题干与高频错误答案分布、
 * 筛选联动（与总览同参数）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnalyticsQuestionsApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
  };
});

const mockedQuestions = vi.mocked(fetchAnalyticsQuestionsApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);

const COURSE_A = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-24T04:00:00.000Z";

/** 课程筛选项（供课程下拉可选） */
const COURSES = {
  courses: [
    {
      id: COURSE_A,
      name: "初一数学·上学期",
      description: null,
      archived: false,
      archivedAt: null,
      order: 0,
      memberCount: 3,
      itemCount: 2,
      visibleItemCount: 2,
      memberIds: [],
      hasAttempts: true,
      createdAt: NOW,
    },
  ],
};

function makeQuestions(
  overrides: Partial<AnalyticsQuestionsData> = {},
): AnalyticsQuestionsData {
  return {
    range: { days: 30, from: "2026-08-25T04:00:00.000Z", to: NOW },
    questions: [
      {
        questionId: "unit-u1-3",
        unitId: "unit-u1",
        unitTitle: "有理数随堂练习",
        type: "fill",
        difficulty: 2,
        knowledge: ["有理数加法"],
        stemMd: "计算：$(-3)+7=$ [[4]]。",
        submittedCount: 4,
        judgedCount: 4,
        correctCount: 2,
        pendingCount: 0,
        correctRate: 0.5,
        avgSec: 75,
        medianSec: 60,
        anomalyCount: 2,
        wrongAnswers: [
          { answerText: "7", count: 2 },
          { answerText: null, count: 1 },
        ],
        lastSubmittedAt: NOW,
      },
      {
        questionId: "unit-u1-1",
        unitId: "unit-u1",
        unitTitle: "有理数随堂练习",
        type: "judge",
        difficulty: 1,
        knowledge: ["有理数的概念"],
        stemMd: "$0$ 是正数。[[错误]]",
        submittedCount: 3,
        judgedCount: 3,
        correctCount: 1,
        pendingCount: 2,
        correctRate: 1 / 3,
        avgSec: 40,
        medianSec: 40,
        anomalyCount: 0,
        wrongAnswers: [],
        lastSubmittedAt: NOW,
      },
    ],
    ...overrides,
  };
}

function renderPage(initialEntry = "/t/insights/questions") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/insights/questions"
            element={<InsightsQuestionsPage />}
          />
          <Route path="/t/insights" element={<p>overview page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCourses.mockResolvedValue(COURSES);
});

describe("InsightsQuestionsPage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedQuestions.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载题目统计…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复", async () => {
    mockedQuestions.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("题目统计加载失败")).toBeInTheDocument();
    mockedQuestions.mockResolvedValue(makeQuestions());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // 两行的单元同名——断言表格恢复而非重复文本
    expect(
      await screen.findByRole("table", { name: /题目统计/ }),
    ).toBeInTheDocument();
  });

  it("空数据给出指引空态", async () => {
    mockedQuestions.mockResolvedValue(makeQuestions({ questions: [] }));
    renderPage();
    expect(
      await screen.findByText("当前范围内没有题目统计"),
    ).toBeInTheDocument();
  });
});

describe("InsightsQuestionsPage 表格口径", () => {
  it("对率/待批/异常计数按契约数值展示；行序保持服务端稳定序", async () => {
    mockedQuestions.mockResolvedValue(makeQuestions());
    renderPage();
    const table = await screen.findByRole("table", {
      name: /题目统计：正确率、用时与高频错误答案/,
    });

    // 第一行（fill 题）：对率 50%、异常 2；第二行（judge 题）：对率 33%、待批 2
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(3); // 表头 + 2 数据行
    expect(table).toHaveTextContent("50%");
    expect(table).toHaveTextContent("33%");
    expect(table).toHaveTextContent("待批 2");
    expect(table).toHaveTextContent("2");

    // 题干截断（数学标记粗略拍平：[[4]] → ____）
    expect(screen.getByText(/计算：\(3\)\+7=/)).toBeInTheDocument();
  });

  it("展开行：题干全文（RichMarkdown）+ 高频错误答案分布（含未作答条目）", async () => {
    mockedQuestions.mockResolvedValue(makeQuestions());
    renderPage();
    await screen.findByRole("table", { name: /题目统计/ });

    // 默认收起
    expect(screen.queryByText("高频错误答案")).not.toBeInTheDocument();

    // 展开第一行
    fireEvent.click(
      screen.getAllByRole("button", { name: /计算：/ })[0] as HTMLElement,
    );
    expect(screen.getByText("高频错误答案")).toBeInTheDocument();
    expect(screen.getByText("7 × 2")).toBeInTheDocument();
    expect(screen.getByText("（未作答） × 1")).toBeInTheDocument();
    expect(screen.getByText(/考点：有理数加法/)).toBeInTheDocument();

    // 再点收起
    fireEvent.click(
      screen.getAllByRole("button", { name: /计算：/ })[0] as HTMLElement,
    );
    expect(screen.queryByText("高频错误答案")).not.toBeInTheDocument();
  });

  it("无错误答案分布的行展开显示解释文案", async () => {
    mockedQuestions.mockResolvedValue(makeQuestions());
    renderPage();
    await screen.findByRole("table", { name: /题目统计/ });
    fireEvent.click(screen.getByRole("button", { name: /0 是正数/ }));
    expect(
      screen.getByText(/无错误答案分布（题型不聚合或窗口内没有判错）。/),
    ).toBeInTheDocument();
  });
});

describe("InsightsQuestionsPage 筛选联动与视图切换", () => {
  it("默认无参数；切换时间范围与课程后带参重查；切回总览携带筛选", async () => {
    mockedQuestions.mockResolvedValue(makeQuestions());
    renderPage();
    await screen.findByRole("table", { name: /题目统计/ });
    expect(mockedQuestions).toHaveBeenLastCalledWith({});

    fireEvent.click(screen.getByRole("button", { name: "最近 7 天" }));
    await waitFor(() => {
      expect(mockedQuestions).toHaveBeenLastCalledWith({ days: 7 });
    });

    fireEvent.change(screen.getByLabelText("课程"), {
      target: { value: COURSE_A },
    });
    await waitFor(() => {
      expect(mockedQuestions).toHaveBeenLastCalledWith({
        days: 7,
        courseId: COURSE_A,
      });
    });

    // 视图切换链接携带当前筛选回总览
    expect(screen.getByRole("link", { name: "总览" })).toHaveAttribute(
      "href",
      `/t/insights?days=7&courseId=${COURSE_A}`,
    );
  });
});
