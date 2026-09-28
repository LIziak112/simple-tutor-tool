import { screen } from "@testing-library/react";
import type { StudentCourseListData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentCoursesApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentCoursesPage from "./StudentCoursesPage";

/**
 * 我的课程页组件测试（T2A.5）：课程卡片渲染（名称/简介/计数/进度条/链接）、
 * 「按讲义浏览」二级入口、空态、错误态。API 层 mock
 * （后端行为由 student-courses.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentCoursesApi: vi.fn(),
  };
});

const mockedCourses = vi.mocked(fetchStudentCoursesApi);

const COURSES: StudentCourseListData = {
  courses: [
    {
      id: "12121212-1212-4121-8121-121212121212",
      name: "初一上",
      description: "有理数与数轴",
      visibleLectureCount: 3,
      visibleUnitCount: 5,
      completedUnitCount: 0,
    },
    {
      id: "23232323-2323-4232-8232-232323232323",
      name: "计算专项",
      description: null,
      visibleLectureCount: 2,
      visibleUnitCount: 0,
      completedUnitCount: 0,
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/courses",
    routePath: "/s/courses",
    element: <StudentCoursesPage />,
  });
}

beforeEach(() => {
  mockedCourses.mockReset();
});

describe("StudentCoursesPage", () => {
  it("渲染课程卡片：名称、简介、可见计数、进度条与目录链接", async () => {
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    const first = await screen.findByRole("link", {
      name: "打开课程 初一上",
    });
    expect(first).toHaveAttribute(
      "href",
      "/s/courses/12121212-1212-4121-8121-121212121212",
    );
    expect(screen.getByText("有理数与数轴")).toBeInTheDocument();
    expect(screen.getByText("3 篇讲义 · 5 个练习")).toBeInTheDocument();
    expect(screen.getByText("0/5")).toBeInTheDocument();
    // 无可见练习：显示「练习即将开放」
    expect(screen.getByText("练习即将开放")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "打开课程 计算专项" }),
    ).toBeInTheDocument();
  });

  it("「按讲义浏览」二级入口指向讲义列表", async () => {
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    expect(
      await screen.findByRole("link", { name: /按讲义浏览/ }),
    ).toHaveAttribute("href", "/s/lectures");
  });

  it("空态：还没有加入课程（引导文案）", async () => {
    mockedCourses.mockResolvedValue({ courses: [] });
    renderPage();

    expect(await screen.findByText("还没有加入课程")).toBeInTheDocument();
    expect(screen.getByText(/请联系老师把你加入课程/)).toBeInTheDocument();
  });

  it("错误态：加载失败与重试", async () => {
    mockedCourses.mockRejectedValue(new Error("连不上服务器"));
    renderPage();

    expect(await screen.findByText("课程加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
