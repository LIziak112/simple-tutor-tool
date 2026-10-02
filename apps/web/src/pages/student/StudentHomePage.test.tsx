import { screen } from "@testing-library/react";
import type {
  StudentAssignmentListData,
  StudentCourseListData,
  WrongQuestionsData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStudentAssignmentsApi,
  fetchStudentCoursesApi,
  fetchStudentWrongQuestionsApi,
} from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentHomePage from "./StudentHomePage";

/**
 * 学生首页组件测试（T2A.5 改版 + 2026-10 IA 调整）：待完成作业卡片 +
 * 我的课程卡片（进度条占位）+「按讲义浏览」二级入口 + 错题本概览卡
 * （待复习/已攻克计数 + 去复习入口）；作业/课程/错题本空态、错误态；
 * 首页不再有「我的记录」入口（顶栏导航独占）。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAssignmentsApi: vi.fn(),
    fetchStudentCoursesApi: vi.fn(),
    fetchStudentWrongQuestionsApi: vi.fn(),
  };
});

const mockedAssignments = vi.mocked(fetchStudentAssignmentsApi);
const mockedCourses = vi.mocked(fetchStudentCoursesApi);
const mockedWrong = vi.mocked(fetchStudentWrongQuestionsApi);

const ASSIGNMENTS: StudentAssignmentListData = {
  assignments: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "周末加练",
      units: [
        { id: "unit-一元一次方程", title: "一元一次方程" },
        { id: "unit-绝对值", title: "绝对值" },
      ],
      unitCount: 2,
      questionCount: 5,
      dueAt: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-09-26T08:00:00.000Z",
      status: "not_started",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "课前预习",
      units: [{ id: "unit-有理数", title: "有理数" }],
      unitCount: 1,
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

/** 错题本全量形态（includeResolved=true）：1 道仍错 + 1 道已攻克 */
const WRONG_DATA: WrongQuestionsData = {
  questions: [
    {
      sourceType: "course",
      courseId: "12121212-1212-4121-8121-121212121212",
      courseName: "初一上",
      assignmentId: null,
      assignmentTitle: null,
      unitId: "unit-有理数",
      unitTitle: "有理数",
      attemptNo: 1,
      questionId: "q-judge-1",
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
      stemMd: "$1$ 是正数。[[正确]]",
      answers: { kind: "judge", value: true },
      solutionMd: "$1$ 大于 $0$，是正数。",
      answerText: "错",
      firstCorrect: false,
      resolved: false,
      firstAt: "2026-09-20T02:00:00.000Z",
      lastAt: "2026-09-28T02:00:00.000Z",
    },
    {
      sourceType: "course",
      courseId: "12121212-1212-4121-8121-121212121212",
      courseName: "初一上",
      assignmentId: null,
      assignmentTitle: null,
      unitId: "unit-有理数",
      unitTitle: "有理数",
      attemptNo: 2,
      questionId: "q-fill-2",
      type: "fill",
      difficulty: 2,
      knowledge: ["有理数加法"],
      stemMd: "计算：$(-2)+5=$（　）。",
      answers: { kind: "fill", blanks: [["3"]] },
      solutionMd: "$(-2)+5=3$。",
      answerText: "3",
      firstCorrect: false,
      resolved: true,
      firstAt: "2026-09-21T02:00:00.000Z",
      lastAt: "2026-09-29T02:00:00.000Z",
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
  mockedWrong.mockReset();
  // 默认无错题（多数用例不关心错题本；需要时各自覆盖）
  mockedWrong.mockResolvedValue({ questions: [] });
});

describe("StudentHomePage", () => {
  it("渲染作业卡片：标题、单元、题数、截止北京时间、不限截止、状态徽章", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    // 第一份作业：有截止（UTC 12:00 = 北京时间 20:00）
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    // T2A.7：多单元卡片显示「n 个单元（标题列表）」；单单元显示「单元：标题」
    expect(
      screen.getByText("2 个单元（一元一次方程、绝对值）"),
    ).toBeInTheDocument();
    expect(screen.getByText("单元：有理数")).toBeInTheDocument();
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

  // —— 2026-10 IA 调整：错题本概览卡 + 移除「我的记录」重复入口 ——

  it("首页不再有「我的记录」入口（顶栏导航独占，去重复）", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    await screen.findByText("周末加练");
    expect(
      screen.queryByRole("link", { name: /我的记录/ }),
    ).not.toBeInTheDocument();
  });

  it("错题本概览卡：待复习/已攻克计数 + 去复习入口指向 /s/wrong", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    mockedWrong.mockResolvedValue(WRONG_DATA);
    renderPage();

    expect(
      await screen.findByText("待复习 1 题 · 已攻克 1 题"),
    ).toBeInTheDocument();
    const reviewLink = screen.getByRole("link", { name: "去复习" });
    expect(reviewLink).toHaveAttribute("href", "/s/wrong");
  });

  it("错题本空态：还没有错题的解释文案 + 查看错题本次级入口", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    renderPage();

    expect(await screen.findByText("还没有错题")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看错题本" })).toHaveAttribute(
      "href",
      "/s/wrong",
    );
  });

  it("错题本加载失败显示错误态与重试按钮（不影响作业与课程分区）", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedCourses.mockResolvedValue(COURSES);
    mockedWrong.mockRejectedValue(new Error("服务器响应异常"));
    renderPage();

    expect(await screen.findByText("错题本加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
  });
});
