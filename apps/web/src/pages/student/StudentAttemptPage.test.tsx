import { screen } from "@testing-library/react";
import type { AttemptDraftData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchAttemptApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAttemptPage from "./StudentAttemptPage";

/**
 * /s/attempts/:attemptId 通用答题页组件测试（T2A.6）：按 attemptId 直接加载
 * 详情（两种来源共用）；课程来源显示「课程：xx · 第 n 次」与返回单元落地页；
 * 403/404 → 终态面板「已无权限访问该练习」（D7，不做无限重试）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAttemptApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchAttemptApi);

const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

/** 课程练习草稿视图（第 2 次） */
const COURSE_DRAFT: AttemptDraftData = {
  attempt: {
    id: ATTEMPT_ID,
    sourceType: "course",
    assignmentId: null,
    courseId: COURSE_ID,
    unitId: "有理数小练",
    attemptNo: 2,
    status: "draft",
    startedAt: "2026-09-27T02:00:00.000Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  // T2A.7：草稿视图题目按单元分组（course 来源单组）
  units: [
    {
      id: "有理数小练",
      title: "有理数小练",
      questions: [
        {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/attempts/${ATTEMPT_ID}`,
    routePath: "/s/attempts/:attemptId",
    element: <StudentAttemptPage />,
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("StudentAttemptPage（/s/attempts/:attemptId，T2A.6）", () => {
  it("课程来源草稿：渲染答题会话与来源行「课程：xx · 第 n 次」+ 返回单元落地页", async () => {
    mockedFetch.mockResolvedValue(COURSE_DRAFT);
    renderPage();
    // 来源行 + 答题视图（交卷入口出现即会话已渲染）
    expect(
      await screen.findByText("课程：初一上 · 第 2 次"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回单元练习" })).toHaveAttribute(
      "href",
      `/s/courses/${COURSE_ID}/units/${encodeURIComponent("有理数小练")}`,
    );
    expect(screen.getByRole("button", { name: "交卷" })).toBeInTheDocument();
  });

  it("已交卷的课程作答：直接结果视图（只读回看）", async () => {
    mockedFetch.mockResolvedValue({
      ...COURSE_DRAFT,
      attempt: {
        ...COURSE_DRAFT.attempt,
        status: "submitted",
        submittedAt: "2026-09-27T02:30:00.000Z",
        scoreAuto: 100,
      },
      summary: {
        total: 1,
        answered: 1,
        correct: 1,
        wrong: 0,
        pending: 0,
        unanswered: 0,
        autoGradable: 1,
      },
      units: [],
    });
    renderPage();
    expect(await screen.findByText(/得分/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "交卷" }),
    ).not.toBeInTheDocument();
  });

  it("403（移出成员，D7）：终态面板「已无权限访问该练习」，不提供重试", async () => {
    mockedFetch.mockRejectedValue(
      new ApiError("COURSE_ACCESS_DENIED", "无法访问该课程", 403),
    );
    renderPage();
    expect(await screen.findByText("已无权限访问该练习")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });

  it("404 同样终态；网络错误仍走通用重试面板", async () => {
    mockedFetch.mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    renderPage();
    expect(await screen.findByText("已无权限访问该练习")).toBeInTheDocument();
  });

  it("网络错误：通用错误面板 + 重试", async () => {
    mockedFetch.mockRejectedValue(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("练习加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
