import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { StudentUnitLandingData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentUnitLandingApi, startCourseAttemptApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentCourseUnitPage from "./StudentCourseUnitPage";

/**
 * 单元落地页组件测试（T2A.6，D10）：题数/题型分布/历次记录/得分汇总渲染、
 * 入口三态（开始练习 / 继续作答 / 再做一次确认）、越权 403/404 友好引导。
 * API 层 mock（后端行为由 student-course-attempts.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentUnitLandingApi: vi.fn(),
    startCourseAttemptApi: vi.fn(),
  };
});

const mockedLanding = vi.mocked(fetchStudentUnitLandingApi);
const mockedStart = vi.mocked(startCourseAttemptApi);

const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const UNIT_ID = "有理数小练";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

/** 从未做过 */
const NEVER_DONE: StudentUnitLandingData = {
  courseId: COURSE_ID,
  courseName: "初一上",
  unitId: UNIT_ID,
  title: "有理数小练",
  topic: "正数与负数",
  questionCount: 4,
  typeDistribution: { judge: 2, fill: 2 },
  attempts: [],
  summary: null,
};

/** 已交卷一次（可再做一次） */
const SUBMITTED_ONCE: StudentUnitLandingData = {
  ...NEVER_DONE,
  attempts: [
    {
      attemptId: ATTEMPT_ID,
      attemptNo: 1,
      status: "submitted",
      score: 75,
      startedAt: "2026-09-27T02:00:00.000Z",
      submittedAt: "2026-09-27T02:30:00.000Z",
    },
  ],
  summary: {
    count: 1,
    submittedCount: 1,
    hasDraft: false,
    firstScore: 75,
    latestScore: 75,
    bestScore: 75,
    pendingCount: 1,
  },
};

function renderPage(landing?: StudentUnitLandingData) {
  if (landing !== undefined) mockedLanding.mockResolvedValue(landing);
  return renderWithStudentRoutes({
    initialPath: `/s/courses/${COURSE_ID}/units/${UNIT_ID}`,
    routePath: "/s/courses/:id/units/:unitId",
    element: <StudentCourseUnitPage />,
  });
}

beforeEach(() => {
  mockedLanding.mockReset();
  mockedStart.mockReset();
  mockedStart.mockResolvedValue({
    id: ATTEMPT_ID,
    sourceType: "course",
    assignmentId: null,
    courseId: COURSE_ID,
    unitId: UNIT_ID,
    attemptNo: 1,
    status: "draft",
    startedAt: "2026-09-27T02:00:00.000Z",
    submittedAt: null,
    scoreAuto: null,
  });
});

describe("StudentCourseUnitPage", () => {
  it("从未做过：渲染题数/题型分布/历次空态，「开始练习」直达答题页", async () => {
    const utils = renderPage(NEVER_DONE);
    expect(await screen.findByText("有理数小练")).toBeInTheDocument();
    expect(screen.getByText("课程：初一上")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent === "共 4 题"),
    ).toBeInTheDocument();
    expect(screen.getByText("判断 2 · 填空 2")).toBeInTheDocument();
    expect(screen.getByText(/历次记录（0）/)).toBeInTheDocument();
    expect(screen.getByText(/还没有做过/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "开始练习 有理数小练" }),
    );
    await waitFor(() => expect(mockedStart).toHaveBeenCalledTimes(1));
    // 跳转通用答题页 /s/attempts/:attemptId（路由桩「未匹配」承接）
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("已交卷一次：显示得分汇总与历次记录；「再做一次」先确认（第 n+1 次、从空白开始）", async () => {
    const utils = renderPage(SUBMITTED_ONCE);
    expect(await screen.findByText(/已做 1 次/)).toBeInTheDocument();
    expect(screen.getByText(/首次 75 分/)).toBeInTheDocument();
    expect(screen.getByText(/有 1 题待批/)).toBeInTheDocument();
    // 历次记录：点击进入该次结果视图（只读）
    expect(
      screen.getByRole("button", { name: "查看第 1 次记录" }),
    ).toBeInTheDocument();

    // 再做一次：确认弹层 → 确认后开始新一次
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再做一次" }));
    expect(screen.getByRole("dialog", { name: "再做一次确认" })).toBeVisible();
    expect(screen.getByText(/将开始第 2 次，从空白开始/)).toBeInTheDocument();
    expect(mockedStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始新一次" }));
    await waitFor(() => expect(mockedStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("存在未交卷作答：入口为「继续作答」（直达那份 draft，无确认弹层）", async () => {
    const hasDraft: StudentUnitLandingData = {
      ...SUBMITTED_ONCE,
      attempts: [
        {
          attemptId: "66666666-6666-4666-8666-666666666666",
          attemptNo: 2,
          status: "draft",
          score: null,
          startedAt: "2026-09-28T02:00:00.000Z",
          submittedAt: null,
        },
        ...SUBMITTED_ONCE.attempts,
      ],
      summary: {
        count: 2,
        submittedCount: 1,
        hasDraft: true,
        firstScore: 75,
        latestScore: 75,
        bestScore: 75,
        pendingCount: 0,
      },
    };
    const utils = renderPage(hasDraft);
    await screen.findByRole("button", { name: "继续作答" });
    fireEvent.click(screen.getByRole("button", { name: "继续作答" }));
    await waitFor(() => expect(mockedStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("越权（403 COURSE_ACCESS_DENIED）：中文引导 + 返回我的课程", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedLanding.mockRejectedValue(
      new ApiError("COURSE_ACCESS_DENIED", "无法访问该课程", 403),
    );
    renderWithStudentRoutes({
      initialPath: `/s/courses/${COURSE_ID}/units/${UNIT_ID}`,
      routePath: "/s/courses/:id/units/:unitId",
      element: <StudentCourseUnitPage />,
    });
    expect(await screen.findByText("暂时看不到这个练习")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute(
      "href",
      "/s/courses",
    );
  });

  it("条目不可见（404 NOT_FOUND）：提示未开放 + 返回课程目录", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedLanding.mockRejectedValue(
      new ApiError("NOT_FOUND", "没有找到该内容", 404),
    );
    renderWithStudentRoutes({
      initialPath: `/s/courses/${COURSE_ID}/units/${UNIT_ID}`,
      routePath: "/s/courses/:id/units/:unitId",
      element: <StudentCourseUnitPage />,
    });
    expect(await screen.findByText("练习还没有开放")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
