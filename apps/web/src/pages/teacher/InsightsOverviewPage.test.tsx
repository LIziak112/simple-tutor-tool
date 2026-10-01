import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnalyticsOverviewData, CourseListData } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAnalyticsOverviewApi, fetchTeacherCourses } from "@/lib/api";
import InsightsOverviewPage from "./InsightsOverviewPage";

/**
 * /t/insights 学情总览组件测试（T4.2）：三态、完成矩阵五状态与单元列口径、
 * 关键计数、重点卡片与跳转关系、筛选联动（时间范围/课程/重点周期 → 接口参数
 * 与 URL）。API 层 mock（真实口径由 T4.1 服务测试覆盖）；fixtures 对齐
 * seed-demo 构成（3 学生 / 作业+单元列 / 五状态全覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnalyticsOverviewApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
  };
});

const mockedOverview = vi.mocked(fetchAnalyticsOverviewApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const COURSE_A = "44444444-4444-4444-8444-444444444444";
const A1 = "55555555-5555-4555-8555-555555555555";
const A2 = "66666666-6666-4666-8666-666666666666";
const ATT_S1_A1 = "77777777-7777-4777-8777-777777777771";
const ATT_S2_A1 = "77777777-7777-4777-8777-777777777772";
const ATT_S3_A1 = "77777777-7777-4777-8777-777777777773";
const ATT_S1_A2 = "77777777-7777-4777-8777-777777777774";
const ATT_REP = "88888888-8888-4888-8888-888888888888";

const NOW = "2026-09-24T04:00:00.000Z";

const COURSES: CourseListData = {
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
      memberIds: [S1, S2, S3],
      hasAttempts: true,
      createdAt: NOW,
    },
  ],
};

/** 总览数据工厂（对齐 seed-demo 构成：五状态 + 单元列口径全覆盖） */
function makeOverview(
  overrides: Partial<AnalyticsOverviewData> = {},
): AnalyticsOverviewData {
  return {
    range: { days: 30, from: "2026-08-25T04:00:00.000Z", to: NOW },
    focusDays: 14,
    matrix: {
      students: [
        { studentId: S1, displayName: "陈小明", archived: false },
        { studentId: S2, displayName: "李小红", archived: false },
        { studentId: S3, displayName: "王小刚", archived: false },
      ],
      assignmentColumns: [
        {
          assignmentId: A1,
          title: "开学摸底练习",
          dueAt: NOW,
          courseId: COURSE_A,
          courseName: "初一数学·上学期",
        },
        {
          assignmentId: A2,
          title: "周末加练",
          dueAt: null,
          courseId: null,
          courseName: null,
        },
      ],
      unitColumns: [
        {
          courseId: COURSE_A,
          courseName: "初一数学·上学期",
          unitId: "unit-u1",
          unitTitle: "有理数随堂练习",
          order: 0,
        },
      ],
      cells: [
        {
          kind: "assignment",
          studentId: S1,
          assignmentId: A1,
          status: "graded",
          attemptId: ATT_S1_A1,
          submittedAt: NOW,
        },
        {
          kind: "assignment",
          studentId: S2,
          assignmentId: A1,
          status: "submitted",
          attemptId: ATT_S2_A1,
          submittedAt: NOW,
        },
        {
          kind: "assignment",
          studentId: S3,
          assignmentId: A1,
          status: "graded",
          attemptId: ATT_S3_A1,
          submittedAt: NOW,
        },
        {
          kind: "assignment",
          studentId: S1,
          assignmentId: A2,
          status: "in-progress",
          attemptId: ATT_S1_A2,
          submittedAt: null,
        },
        {
          kind: "assignment",
          studentId: S2,
          assignmentId: A2,
          status: "not-started",
          attemptId: null,
          submittedAt: null,
        },
        {
          kind: "assignment",
          studentId: S3,
          assignmentId: A2,
          status: "not-assigned",
          attemptId: null,
          submittedAt: null,
        },
        {
          kind: "course-unit",
          studentId: S1,
          courseId: COURSE_A,
          unitId: "unit-u1",
          status: "graded",
          attemptCount: 3,
          redoCount: 2,
          firstScore: 100,
          pendingCount: 0,
          latestSubmittedAt: NOW,
        },
        {
          kind: "course-unit",
          studentId: S2,
          courseId: COURSE_A,
          unitId: "unit-u1",
          status: "submitted",
          attemptCount: 1,
          redoCount: 0,
          firstScore: 80,
          pendingCount: 2,
          latestSubmittedAt: NOW,
        },
        {
          kind: "course-unit",
          studentId: S3,
          courseId: COURSE_A,
          unitId: "unit-u1",
          status: "not-started",
          attemptCount: 0,
          redoCount: 0,
          firstScore: null,
          pendingCount: 0,
          latestSubmittedAt: null,
        },
      ],
    },
    trend: [
      {
        weekStart: "2026-09-14",
        attemptCount: 2,
        judgedCount: 6,
        correctCount: 4,
        correctRate: 2 / 3,
      },
      {
        weekStart: "2026-09-21",
        attemptCount: 1,
        judgedCount: 6,
        correctCount: 4,
        correctRate: 2 / 3,
      },
    ],
    focus: {
      focusDays: 14,
      from: "2026-09-10T04:00:00.000Z",
      points: [
        {
          knowledge: "有理数加法",
          wrongCount: 2,
          judgedCount: 3,
          correctRate: 1 / 3,
          representative: {
            questionId: "unit-u1-3",
            stemMd: "计算：$(-3)+7=$ [[4]]。",
            type: "fill",
            difficulty: 2,
            knowledge: ["有理数加法"],
            attemptId: ATT_REP,
            studentId: S2,
            studentName: "李小红",
            answerText: "7",
            submittedAt: NOW,
          },
        },
      ],
    },
    pendingMarkCount: 3,
    studentCount: 3,
    redoCount: 2,
    offline: { offlineShare: 2 / 3, activeSecTotal: 990, offlineSecTotal: 60 },
    overall: { judgedCount: 12, correctCount: 8, correctRate: 2 / 3 },
    ...overrides,
  };
}

/** 路由地址探针（断言筛选写进 URL） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

function renderPage(initialEntry = "/t/insights") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/insights"
            element={
              <>
                <InsightsOverviewPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/t/insights/questions" element={<p>questions page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCourses.mockResolvedValue(COURSES);
});

describe("InsightsOverviewPage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedOverview.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载学情总览…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复", async () => {
    mockedOverview.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("学情总览加载失败")).toBeInTheDocument();
    mockedOverview.mockResolvedValue(makeOverview());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("下节课重点")).toBeInTheDocument();
  });

  it("无学生且无列时给出起步指引空态", async () => {
    mockedOverview.mockResolvedValue(
      makeOverview({
        studentCount: 0,
        matrix: {
          students: [],
          assignmentColumns: [],
          unitColumns: [],
          cells: [],
        },
      }),
    );
    renderPage();
    expect(
      await screen.findByText("还没有可统计的学情数据"),
    ).toBeInTheDocument();
  });
});

describe("InsightsOverviewPage 完成矩阵（D2）", () => {
  it("五状态徽标齐全；未指派渲染「—」；单元列显示做过次数/首次得分/重做/待批", async () => {
    mockedOverview.mockResolvedValue(makeOverview());
    renderPage();
    await screen.findByText("开学摸底练习");

    // 五状态：已批（s1a1）、已交（s2a1）、进行中（s1a2）、未开始（s2a2 与 s3 单元）、未指派（s3a2 → 「—」）
    expect(screen.getAllByText("已批").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已交").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("进行中").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("未开始").length).toBeGreaterThanOrEqual(1);
    expect(
      screen
        .getAllByTitle("该学生不在名单 / 不是课程成员")
        .some((el) => el.textContent === "—"),
    ).toBe(true);

    // 单元列口径：陈小明 做过 3 次 · 首次 100 分 + 重做 2；李小红 待批 2
    expect(screen.getByText("做过 3 次 · 首次 100 分")).toBeInTheDocument();
    expect(screen.getByText("重做 2")).toBeInTheDocument();
    expect(screen.getByText("待批 2")).toBeInTheDocument();
  });

  it("作业格与学生名的跳转关系：格子→作答详情、学生名→画像、待批卡片→待批队列", async () => {
    mockedOverview.mockResolvedValue(makeOverview());
    renderPage();
    await screen.findByText("开学摸底练习");

    const cellLink = screen.getByRole("link", {
      name: "查看 陈小明 的「开学摸底练习」作答详情",
    });
    expect(cellLink).toHaveAttribute("href", `/t/data/attempts/${ATT_S1_A1}`);

    const studentLink = screen.getByRole("link", { name: "陈小明" });
    expect(studentLink).toHaveAttribute("href", `/t/insights/students/${S1}`);

    const pendingLink = screen.getByRole("link", { name: /去待批队列/ });
    expect(pendingLink).toHaveAttribute("href", "/t/data/pending");

    const focusLink = screen.getByRole("link", { name: "查看作答详情" });
    expect(focusLink).toHaveAttribute("href", `/t/data/attempts/${ATT_REP}`);

    // 视图切换到题目视角（携带当前筛选）
    expect(screen.getByRole("link", { name: "题目视角" })).toHaveAttribute(
      "href",
      "/t/insights/questions",
    );
  });

  it("课程筛选时待批队列链接携带 courseId", async () => {
    mockedOverview.mockResolvedValue(makeOverview());
    renderPage(`/t/insights?courseId=${COURSE_A}`);
    await screen.findByText("开学摸底练习");
    const pendingLink = screen.getByRole("link", { name: /去待批队列/ });
    expect(pendingLink).toHaveAttribute(
      "href",
      `/t/data/pending?courseId=${COURSE_A}`,
    );
  });
});

describe("InsightsOverviewPage 关键计数与重点卡片", () => {
  it("待批/重做/离线/总正确率按契约数值展示；重点卡片含考点与代表错题", async () => {
    mockedOverview.mockResolvedValue(makeOverview());
    renderPage();
    await screen.findByText("下节课重点");

    expect(
      screen.getByText("3", { selector: ".text-2xl" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 次")).toBeInTheDocument();
    // 离线占比与总正确率同为 67%（D4 口径）
    expect(screen.getAllByText("67%")).toHaveLength(2);
    expect(screen.getByText(/对 8 \/ 已判定 12 题/)).toBeInTheDocument();
    expect(screen.getByText("离线 1 分钟 / 有效 17 分钟")).toBeInTheDocument();

    expect(screen.getByText("有理数加法")).toBeInTheDocument();
    expect(screen.getByText("判错 2 题 · 已判定 3 题")).toBeInTheDocument();
    expect(screen.getByText(/学生答案：7/)).toBeInTheDocument();
  });

  it("重点卡片空周期显示空态文案", async () => {
    mockedOverview.mockResolvedValue(
      makeOverview({ focus: { focusDays: 14, from: NOW, points: [] } }),
    );
    renderPage();
    expect(
      await screen.findByText("周期内没有判错记录，继续保持。"),
    ).toBeInTheDocument();
  });
});

describe("InsightsOverviewPage 筛选联动（D3/D5）", () => {
  it("默认不带参数请求；切换时间范围/课程/重点周期后带参重查并写 URL", async () => {
    mockedOverview.mockResolvedValue(makeOverview());
    renderPage();
    await screen.findByText("开学摸底练习");
    expect(mockedOverview).toHaveBeenLastCalledWith({});

    // 时间范围 → 全部
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => {
      expect(mockedOverview).toHaveBeenLastCalledWith({ days: "all" });
    });
    expect(screen.getByTestId("location-probe")).toHaveTextContent("days=all");

    // 课程筛选
    fireEvent.change(screen.getByLabelText("课程"), {
      target: { value: COURSE_A },
    });
    await waitFor(() => {
      expect(mockedOverview).toHaveBeenLastCalledWith({
        days: "all",
        courseId: COURSE_A,
      });
    });
    expect(screen.getByTestId("location-probe")).toHaveTextContent(
      `courseId=${COURSE_A}`,
    );

    // 重点周期（仅总览携带）
    fireEvent.change(screen.getByLabelText("下节课重点周期"), {
      target: { value: "30" },
    });
    await waitFor(() => {
      expect(mockedOverview).toHaveBeenLastCalledWith({
        days: "all",
        courseId: COURSE_A,
        focusDays: 30,
      });
    });
    expect(screen.getByTestId("location-probe")).toHaveTextContent(
      "focusDays=30",
    );

    // URL 初始化的筛选同样生效（直接打开 /t/insights?days=7）
    mockedOverview.mockClear();
    renderPage("/t/insights?days=7");
    await waitFor(() => {
      expect(mockedOverview).toHaveBeenLastCalledWith({ days: 7 });
    });
  });
});
