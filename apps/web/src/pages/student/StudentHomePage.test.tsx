import { screen } from "@testing-library/react";
import type {
  StudentAssignmentListData,
  StudentCourseListData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentAssignmentsApi, fetchStudentCoursesApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentHomePage from "./StudentHomePage";

/**
 * 学生首页组件测试（T2A.5 改版）：待完成作业卡片 + 我的课程卡片（进度条占位）
 * +「按讲义浏览」二级入口；作业与课程空态、错误态。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAssignmentsApi: vi.fn(),
    fetchStudentCoursesApi: vi.fn(),
  };
});

const mockedAssignments = vi.mocked(fetchStudentAssignmentsApi);
const mockedCourses = vi.mocked(fetchStudentCoursesApi);

const ASSIGNMENTS: StudentAssignmentListData = {
  assignments: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "周末加练",
      unitId: "unit-一元一次方程",
      unitTitle: "一元一次方程",
      topic: "方程",
      questionCount: 5,
      dueAt: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-09-26T08:00:00.000Z",
      status: "not_started",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "课前预习",
      unitId: "unit-有理数",
      unitTitle: "有理数",
      topic: null,
      questionCount: 3,
      dueAt: null,
      createdAt: "2026-09-25T08:00:00.000Z",
      status: "not_started",
    },
  ],
};

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
      visibleLectureCount: 0,
      visibleUnitCount: 0,
      completedUnitCount: 0,
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/home",
    routePath: "/s/home",
    element: <StudentHomePage />,
  });
}

beforeEach(() => {
  mockedAssignments.mockReset();
  mockedCourses.mockReset();
});

describe("StudentHomePage", () => {
  it("渲染作业卡片：标题、单元、题数、截止北京时间、不限截止、状态徽章", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    // 第一份作业：有截止（UTC 12:00 = 北京时间 20:00）
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(screen.getByText("单元：一元一次方程")).toBeInTheDocument();
    expect(screen.getByText("共 5 题")).toBeInTheDocument();
    expect(screen.getByText("10月1日 20:00 截止")).toBeInTheDocument();
    // 两份作业当前都未开始（状态徽章；四态配色见 student-ui）
    expect(screen.getAllByText("未开始").length).toBe(2);
    // 第二份作业：不限截止
    expect(screen.getByText("课前预习")).toBeInTheDocument();
    expect(screen.getByText("不限截止")).toBeInTheDocument();
  });

  it("作业卡片入口是答题页链接（T2.6 起可进入；文案随状态变化）", async () => {
    const first = ASSIGNMENTS.assignments[0];
    const second = ASSIGNMENTS.assignments[1];
    if (first === undefined || second === undefined) {
      throw new Error("测试夹具缺少作业数据");
    }
    mockedAssignments.mockResolvedValue({
      assignments: [
        first,
        { ...second, status: "in_progress" as const },
        {
          ...second,
          id: "88888888-8888-4888-8888-888888888888",
          title: "已交的作业",
          status: "submitted" as const,
        },
      ],
    });
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    const start = await screen.findByRole("link", { name: "开始练习" });
    expect(start).toHaveAttribute("href", `/s/assignments/${first.id}`);
    expect(screen.getByRole("link", { name: "继续作答" })).toHaveAttribute(
      "href",
      `/s/assignments/${second.id}`,
    );
    expect(screen.getByRole("link", { name: "查看结果" })).toHaveAttribute(
      "href",
      "/s/assignments/88888888-8888-4888-8888-888888888888",
    );
  });

  it("渲染我的课程卡片：名称/简介/可见计数/进度条（T2A.6 前恒 0）与课程页链接", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    const courseLink = await screen.findByRole("link", {
      name: "打开课程 初一上",
    });
    expect(courseLink).toHaveAttribute(
      "href",
      "/s/courses/12121212-1212-4121-8121-121212121212",
    );
    expect(screen.getByText("有理数与数轴")).toBeInTheDocument();
    expect(screen.getByText("3 篇讲义 · 5 个练习")).toBeInTheDocument();
    // 进度条占位：已完成 0 / 可见 5（T2A.6 接入作答后填充）
    expect(screen.getByText("0/5")).toBeInTheDocument();
    // 无可见练习的课程显示「练习即将开放」而非 0/0
    expect(screen.getByText("练习即将开放")).toBeInTheDocument();
    expect(screen.queryByText("0/0")).not.toBeInTheDocument();
  });

  it("「按讲义浏览」二级入口指向讲义列表（顶栏导航已无讲义项）", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    const lecturesLink = await screen.findByRole("link", {
      name: /按讲义浏览/,
    });
    expect(lecturesLink).toHaveAttribute("href", "/s/lectures");
  });

  it("作业空态：解释性文案（下一步去课程看讲义）", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    expect(await screen.findByText("现在没有待完成的作业")).toBeInTheDocument();
  });

  it("课程空态：还没有加入课程（引导文案）", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedCourses.mockResolvedValue({ courses: [] });
    renderPage();

    expect(await screen.findByText("还没有加入课程")).toBeInTheDocument();
  });

  it("作业加载失败显示错误态与重试按钮", async () => {
    mockedAssignments.mockRejectedValue(new Error("服务器响应异常"));
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    expect(await screen.findByText("作业加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("课程加载失败显示错误态与重试按钮（两个分区互不影响）", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockRejectedValue(new Error("服务器响应异常"));
    renderPage();

    expect(await screen.findByText("课程加载失败")).toBeInTheDocument();
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
  });
});
