import { screen } from "@testing-library/react";
import type { StudentCourseDetailData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentCourseApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentCourseDetailPage from "./StudentCourseDetailPage";

/**
 * 课程目录页组件测试（T2A.5；T2A.6 单元项接入作答状态）：分节标题、讲义项
 * （链接带 courseId）、单元项（链接进单元落地页 + 状态徽章：未做/进行中/
 * 已完成/有待批）、越权 403 友好引导、空态、错误态。
 * API 层 mock（后端 D22 行为由 student-courses.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentCourseApi: vi.fn(),
  };
});

const mockedCourse = vi.mocked(fetchStudentCourseApi);

const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const LECTURE_ID = "33333333-3333-4333-8333-333333333333";

const DETAIL: StudentCourseDetailData = {
  id: COURSE_ID,
  name: "初一上",
  description: "有理数与数轴",
  items: [
    {
      id: "34343434-3434-4343-8343-343434343434",
      kind: "section",
      refId: null,
      title: "第一章 有理数",
      order: 0,
      questionCount: null,
      attempt: null,
    },
    {
      id: "45454545-4545-4545-8545-454545454545",
      kind: "lecture",
      refId: LECTURE_ID,
      title: "第1讲 有理数",
      order: 1,
      questionCount: null,
      attempt: null,
    },
    {
      id: "56565656-5656-4565-8565-565656565656",
      kind: "unit",
      refId: "有理数小练",
      title: "有理数小练",
      order: 2,
      questionCount: 4,
      attempt: null,
    },
  ],
};

function renderPage(id = COURSE_ID) {
  return renderWithStudentRoutes({
    initialPath: `/s/courses/${id}`,
    routePath: "/s/courses/:id",
    element: <StudentCourseDetailPage />,
  });
}

beforeEach(() => {
  mockedCourse.mockReset();
});

describe("StudentCourseDetailPage", () => {
  it("渲染目录：课程名/简介、分节标题、讲义链接（带 courseId）、单元项（未做，链接进落地页）", async () => {
    mockedCourse.mockResolvedValue(DETAIL);
    renderPage();

    expect(await screen.findByText("初一上")).toBeInTheDocument();
    expect(screen.getByText("有理数与数轴")).toBeInTheDocument();
    // 分节标题（纯文字）
    expect(screen.getByText("第一章 有理数")).toBeInTheDocument();
    // 讲义项：进入阅读页并携带课程上下文
    expect(
      screen.getByRole("link", { name: "阅读讲义 第1讲 有理数" }),
    ).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE_ID}?courseId=${COURSE_ID}`,
    );
    // 单元项：题数 + 未做状态徽章，链接进单元落地页（T2A.6 接入作答）
    expect(screen.getByText("有理数小练")).toBeInTheDocument();
    expect(screen.getByText("4 题")).toBeInTheDocument();
    expect(screen.getAllByText("未做").length).toBe(1);
    expect(
      screen.getByRole("link", { name: "打开练习 有理数小练（4 题）" }),
    ).toHaveAttribute("href", `/s/courses/${COURSE_ID}/units/有理数小练`);
    // 返回我的课程
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute(
      "href",
      "/s/courses",
    );
  });

  it("单元项状态徽章：进行中（hasDraft）", async () => {
    const items = DETAIL.items.map((item) =>
      item.kind === "unit"
        ? {
            ...item,
            attempt: {
              count: 2,
              submittedCount: 1,
              hasDraft: true,
              firstScore: 80,
              latestScore: 80,
              bestScore: 80,
              pendingCount: 0,
            },
          }
        : item,
    );
    mockedCourse.mockResolvedValue({ ...DETAIL, items });
    renderPage();
    expect(await screen.findByText("进行中")).toBeInTheDocument();
  });

  it("单元项状态徽章：已完成（最近 xx 分 · 共 n 次）；有待批优先于已完成", async () => {
    const withAttempt = (attempt: {
      count: number;
      submittedCount: number;
      hasDraft: boolean;
      firstScore: number | null;
      latestScore: number | null;
      bestScore: number | null;
      pendingCount: number;
    }) => ({
      ...DETAIL,
      items: DETAIL.items.map((item) =>
        item.kind === "unit" ? { ...item, attempt } : item,
      ),
    });
    // 已完成（无待批、无草稿）
    mockedCourse.mockResolvedValueOnce(
      withAttempt({
        count: 3,
        submittedCount: 3,
        hasDraft: false,
        firstScore: 60,
        latestScore: 90,
        bestScore: 90,
        pendingCount: 0,
      }),
    );
    renderPage();
    expect(
      await screen.findByText(
        (_, element) =>
          element?.textContent === "已完成（最近 90 分 · 共 3 次）",
      ),
    ).toBeInTheDocument();
  });

  it("单元项状态徽章：有待批（优先于已完成展示）", async () => {
    mockedCourse.mockResolvedValue({
      ...DETAIL,
      items: DETAIL.items.map((item) =>
        item.kind === "unit"
          ? {
              ...item,
              attempt: {
                count: 3,
                submittedCount: 3,
                hasDraft: false,
                firstScore: 60,
                latestScore: 90,
                bestScore: 90,
                pendingCount: 2,
              },
            }
          : item,
      ),
    });
    renderPage();
    expect(await screen.findByText("有待批")).toBeInTheDocument();
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it("空态：老师还没有发布内容", async () => {
    mockedCourse.mockResolvedValue({ ...DETAIL, items: [] });
    renderPage();

    expect(await screen.findByText("老师还没有发布内容")).toBeInTheDocument();
  });

  it("越权（403 COURSE_ACCESS_DENIED）：中文引导 + 返回入口，不用通用错误态", async () => {
    mockedCourse.mockRejectedValue(
      new ApiError(
        "COURSE_ACCESS_DENIED",
        "无法访问该课程（可能已被移出，或课程已结束归档）",
        403,
      ),
    );
    renderPage();

    expect(await screen.findByText("暂时看不到这门课")).toBeInTheDocument();
    expect(screen.getByText(/你可能已被移出这门课/)).toBeInTheDocument();
    // 返回入口存在（页头返回键 + 引导面板内各一个，均指向我的课程）
    const backLinks = screen.getAllByRole("link", { name: "返回我的课程" });
    expect(backLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of backLinks) {
      expect(link).toHaveAttribute("href", "/s/courses");
    }
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });

  it("错误态：加载失败与重试（非越权错误）", async () => {
    mockedCourse.mockRejectedValue(
      new ApiError(
        "NOT_FOUND",
        "没有找到该内容（可能尚未发布或已被移除）",
        404,
      ),
    );
    renderPage();

    expect(await screen.findByText("课程目录加载失败")).toBeInTheDocument();
    expect(
      screen.getByText("没有找到该内容（可能尚未发布或已被移除）"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
