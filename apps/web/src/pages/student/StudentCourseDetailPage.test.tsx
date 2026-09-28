import { screen } from "@testing-library/react";
import type { StudentCourseDetailData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentCourseApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentCourseDetailPage from "./StudentCourseDetailPage";

/**
 * 课程目录页组件测试（T2A.5）：分节标题、讲义项（链接带 courseId）、
 * 单元项（题数 + 即将开放，不可点击）、越权 403 友好引导、空态、错误态。
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
    },
    {
      id: "45454545-4545-4545-8545-454545454545",
      kind: "lecture",
      refId: LECTURE_ID,
      title: "第1讲 有理数",
      order: 1,
      questionCount: null,
    },
    {
      id: "56565656-5656-4565-8565-565656565656",
      kind: "unit",
      refId: "有理数小练",
      title: "有理数小练",
      order: 2,
      questionCount: 4,
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
  it("渲染目录：课程名/简介、分节标题、讲义链接（带 courseId）、单元项（即将开放）", async () => {
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
    // 单元项：题数 + 即将开放，不可点击（T2A.6 接入作答）
    expect(screen.getByText("有理数小练")).toBeInTheDocument();
    expect(screen.getByText("4 题")).toBeInTheDocument();
    expect(screen.getAllByText("即将开放").length).toBe(1);
    const unitItem = screen.getByText("有理数小练").closest("li");
    expect(unitItem?.querySelector("a")).toBeNull();
    // 返回我的课程
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute(
      "href",
      "/s/courses",
    );
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
