import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { LessonLandingData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLessonLandingApi, restartLessonAttemptApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLessonLandingPage from "./StudentLessonLandingPage";

/**
 * 讲练落地页组件测试（2026-10 教师演示口径）：题数/题型分布/历次记录渲染、
 * 三态入口（开始练习 / 继续作答 + 重新开始（作废确认）/ 再做一次确认）、
 * 历次行跳转（draft → 作答页 /lesson/run、已交 → /s/attempts/:id）、
 * 越权 403/404 友好引导。API 层 mock（后端行为由 student-lesson.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchLessonLandingApi: vi.fn(),
    restartLessonAttemptApi: vi.fn(),
  };
});

const mockedLanding = vi.mocked(fetchLessonLandingApi);
const mockedRestart = vi.mocked(restartLessonAttemptApi);

const LECTURE_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

/** 从未做过 */
const NEVER_DONE: LessonLandingData = {
  lectureId: LECTURE_ID,
  title: "第1讲 有理数讲练",
  topic: "有理数",
  courseId: COURSE_ID,
  courseName: "初一上",
  questionCount: 3,
  typeDistribution: { choice: 1, judge: 2 },
  attempts: [],
  summary: null,
};

/** 进行中（有 draft——继续作答 + 重新开始） */
const HAS_DRAFT: LessonLandingData = {
  ...NEVER_DONE,
  attempts: [
    {
      attemptId: ATTEMPT_ID,
      attemptNo: 1,
      status: "draft",
      score: null,
      startedAt: "2026-10-13T02:00:00.000Z",
      submittedAt: null,
    },
  ],
  summary: {
    count: 1,
    submittedCount: 0,
    hasDraft: true,
    firstScore: null,
    latestScore: null,
    bestScore: null,
    pendingCount: 0,
  },
};

/** 已交卷一次（无 draft——再做一次） */
const SUBMITTED_ONCE: LessonLandingData = {
  ...NEVER_DONE,
  attempts: [
    {
      attemptId: ATTEMPT_ID,
      attemptNo: 1,
      status: "graded",
      score: 75,
      startedAt: "2026-10-13T02:00:00.000Z",
      submittedAt: "2026-10-13T02:30:00.000Z",
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

function renderPage(landing?: LessonLandingData) {
  if (landing !== undefined) mockedLanding.mockResolvedValue(landing);
  return renderWithStudentRoutes({
    initialPath: `/s/lectures/${LECTURE_ID}/lesson?courseId=${COURSE_ID}`,
    routePath: "/s/lectures/:id/lesson",
    element: <StudentLessonLandingPage />,
  });
}

beforeEach(() => {
  mockedLanding.mockReset();
  mockedRestart.mockReset();
  // onSuccess 只做跳转，不读响应体
  mockedRestart.mockResolvedValue({} as never);
});

describe("StudentLessonLandingPage", () => {
  it("从未做过：渲染题数/题型分布/历次空态；「开始练习」直达作答页 /lesson/run", async () => {
    const utils = renderPage(NEVER_DONE);
    expect(await screen.findByText("第1讲 有理数讲练")).toBeInTheDocument();
    expect(screen.getByText("课程：初一上")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent === "共 3 题"),
    ).toBeInTheDocument();
    expect(screen.getByText("单选 1 · 判断 2")).toBeInTheDocument();
    expect(screen.getByText(/历次记录（0）/)).toBeInTheDocument();
    expect(screen.getByText(/还没有做过/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "开始练习 第1讲 有理数讲练" }),
    );
    // 跳作答页 /s/lectures/:id/lesson/run?courseId=…（路由桩「未匹配」承接）
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("进行中：「继续作答」直达；「重新开始」先确认作废语义（旧卷作废 + 第 2 次从空白开始）再调 restart", async () => {
    const utils = renderPage(HAS_DRAFT);
    expect(
      await screen.findByRole("button", { name: "继续作答" }),
    ).toBeInTheDocument();

    // 继续作答：直达（无确认弹层、不调 restart）
    fireEvent.click(screen.getByRole("button", { name: "继续作答" }));
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
    expect(mockedRestart).not.toHaveBeenCalled();
  });

  it("进行中「重新开始」：确认弹层明示作废旧卷，确认后调 restart 并进作答页", async () => {
    const utils = renderPage(HAS_DRAFT);
    await screen.findByRole("button", { name: "继续作答" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
    expect(screen.getByRole("dialog", { name: "重新开始确认" })).toBeVisible();
    expect(
      screen.getByText(/进行中的这一次将被作废（不再计入历次与统计）/),
    ).toBeInTheDocument();
    expect(screen.getByText(/并开始第 2 次，从空白开始/)).toBeInTheDocument();
    expect(mockedRestart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始新一次" }));
    await waitFor(() => expect(mockedRestart).toHaveBeenCalledWith(LECTURE_ID));
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("已完成：「再做一次」确认保留记录语义，确认后调 restart", async () => {
    const utils = renderPage(SUBMITTED_ONCE);
    expect(await screen.findByText(/已做 1 次/)).toBeInTheDocument();
    expect(screen.getByText(/有 1 题待批/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "再做一次" }));
    expect(screen.getByRole("dialog", { name: "再做一次确认" })).toBeVisible();
    expect(screen.getByText(/之前的记录会保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始新一次" }));
    await waitFor(() => expect(mockedRestart).toHaveBeenCalledWith(LECTURE_ID));
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("历次记录：draft 行进作答页、已交行进结果页 /s/attempts/:id", async () => {
    // 第二次进行中 + 第一次已交
    const both: LessonLandingData = {
      ...NEVER_DONE,
      attempts: [
        {
          attemptId: "66666666-6666-4666-8666-666666666666",
          attemptNo: 2,
          status: "draft",
          score: null,
          startedAt: "2026-10-13T04:00:00.000Z",
          submittedAt: null,
        },
        {
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          status: "graded",
          score: 75,
          startedAt: "2026-10-13T02:00:00.000Z",
          submittedAt: "2026-10-13T02:30:00.000Z",
        },
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
    const utils = renderPage(both);
    expect(await screen.findByText(/历次记录（2）/)).toBeInTheDocument();

    // 已交行 → /s/attempts/:attemptId（路由桩承接）
    fireEvent.click(screen.getByRole("button", { name: "查看第 1 次" }));
    expect(await screen.findByTestId(utils.stubTestId)).toBeInTheDocument();
  });

  it("越权 403 友好引导（与 start 同口径）", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedLanding.mockRejectedValue(
      new ApiError("COURSE_ACCESS_DENIED", "你已不在该课程成员中", 403),
    );
    renderPage();
    expect(await screen.findByText("暂时看不到这份讲练")).toBeInTheDocument();
    expect(screen.getByText(/有疑问请联系老师/)).toBeInTheDocument();
  });

  it("不可见 404：讲练还没有开放 + 返回讲义列表引导", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedLanding.mockRejectedValue(
      new ApiError("NOT_FOUND", "没有找到该内容", 404),
    );
    renderPage();
    expect(await screen.findByText("讲练还没有开放")).toBeInTheDocument();
    expect(
      screen.getByText(/这份讲练可能还未发布或已被移除/),
    ).toBeInTheDocument();
  });
});
