import { screen } from "@testing-library/react";
import type { StudentLectureListData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentLecturesApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLecturesPage from "./StudentLecturesPage";

/**
 * 学生讲义列表页组件测试（T2.3；T2A.5 按课程分组 + D5）：分组渲染
 * （课程名分组标题/标题/主题/更新时间/进入链接带 courseId）、空态、错误态。
 * API 层 mock（后端行为由 student-lectures.test.ts / student-courses.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentLecturesApi: vi.fn(),
  };
});

const mockedLectures = vi.mocked(fetchStudentLecturesApi);

const LECTURE_1 = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "第1讲 有理数",
  topic: "有理数",
  updatedAt: "2026-09-20T10:00:00.000Z",
} as const;
const LECTURE_2 = {
  id: "66666666-6666-4666-8666-666666666666",
  title: "第2讲 数轴",
  topic: null,
  updatedAt: "2026-09-21T10:00:00.000Z",
} as const;
const COURSE_A = "12121212-1212-4121-8121-121212121212";
const COURSE_B = "23232323-2323-4232-8232-232323232323";

/** 双视图夹具：两门课程分组（第1讲在两门课都出现——分组视图允许重复） */
const LECTURES: StudentLectureListData = {
  lectures: [LECTURE_1, LECTURE_2],
  courses: [
    {
      courseId: COURSE_A,
      courseName: "初一上",
      lectures: [LECTURE_1, LECTURE_2],
    },
    {
      courseId: COURSE_B,
      courseName: "初一下",
      lectures: [LECTURE_1],
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/lectures",
    routePath: "/s/lectures",
    element: <StudentLecturesPage />,
  });
}

beforeEach(() => {
  mockedLectures.mockReset();
});

describe("StudentLecturesPage", () => {
  it("按课程分组渲染：课程名分组标题、讲义链接带 courseId 上下文、返回首页", async () => {
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    // 两个分组标题
    expect(await screen.findByText("初一上")).toBeInTheDocument();
    expect(screen.getByText("初一下")).toBeInTheDocument();

    // 讲义链接带课程上下文（同一讲义在两个分组各有一条链接，按 href 区分）
    const links = screen.getAllByRole("link", { name: /第1讲 有理数/ });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE_1.id}?courseId=${COURSE_A}`,
    );
    expect(links[1]).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURE_1.id}?courseId=${COURSE_B}`,
    );
    // 主题展示（第1讲在两个分组各出现一次 → topic 也两处）+ 更新时间相对显示
    expect(screen.getAllByText("有理数").length).toBe(2);
    expect(screen.getAllByText(/更新$/).length).toBe(3);
    // 返回键（二级页面：回首页）
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
  });

  it("空态：还没有可看的讲义（引导加入课程）", async () => {
    mockedLectures.mockResolvedValue({ lectures: [], courses: [] });
    renderPage();

    expect(await screen.findByText("还没有可看的讲义")).toBeInTheDocument();
  });

  it("错误态：加载失败与重试", async () => {
    mockedLectures.mockRejectedValue(new Error("连不上服务器"));
    renderPage();

    expect(await screen.findByText("讲义加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
