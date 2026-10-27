import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AnalyticsStudentData } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchAnalyticsStudentApi,
  fetchStudentReports,
  fetchTeacherCourses,
} from "@/lib/api";
import StudentHomePage from "./StudentHomePage";

/**
 * /t/students/:id 学生主页组件测试（T-PR1，自 T4.2 画像页迁移改名）：三态
 * （含 404 STUDENT_NOT_FOUND 错误页）、薄弱考点前 5 文字表、异常题/重做/离线
 * 口径、讲义阅读地图中文渲染、AI 报告区、筛选联动。
 * T-PR1 起页面无 ECharts（周趋势/考点条形图随路由归位移除，图表装配口径的
 * 测试随之删除；不再需要 echarts 桩）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnalyticsStudentApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
    // T4.7 报告区（列表默认空；报告区自身行为在 StudentReportsSection.test 覆盖）
    fetchStudentReports: vi.fn(),
  };
});

const mockedStudent = vi.mocked(fetchAnalyticsStudentApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);
const mockedReports = vi.mocked(fetchStudentReports);

const S2 = "22222222-2222-4222-8222-222222222222";
const COURSE_A = "44444444-4444-4444-8444-444444444444";
const LECTURE_1 = "99999999-9999-4999-8999-999999999991";
const ATT_SLOW = "77777777-7777-4777-8777-777777777771";
const ATT_HINTS = "77777777-7777-4777-8777-777777777772";
const ATT_WRONG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ATT_WRONG_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NOW = "2026-09-24T04:00:00.000Z";

/** 学生主页数据工厂（对齐 seed-demo 李小红构成：异常×2、待批、阅读地图） */
function makeStudent(
  overrides: Partial<AnalyticsStudentData> = {},
): AnalyticsStudentData {
  return {
    studentId: S2,
    studentName: "李小红",
    archived: false,
    range: { days: 30, from: "2026-08-25T04:00:00.000Z", to: NOW },
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
        attemptCount: 0,
        judgedCount: 0,
        correctCount: 0,
        correctRate: null,
      },
    ],
    knowledge: [
      {
        knowledge: "数轴",
        correctCount: 1,
        wrongCount: 1,
        pendingCount: 0,
        judgedCount: 2,
        correctRate: 0.5,
      },
      {
        knowledge: "有理数加法",
        correctCount: 0,
        wrongCount: 0,
        pendingCount: 2,
        judgedCount: 0,
        correctRate: null,
      },
    ],
    totals: {
      judgedCount: 6,
      correctCount: 3,
      pendingCount: 2,
      correctRate: 0.5,
    },
    anomalies: [
      {
        attemptId: ATT_SLOW,
        questionId: "unit-u2-2",
        stemMd: "数轴上到原点的距离等于 $3$ 的点表示的数是（　）",
        type: "choice",
        difficulty: 2,
        knowledge: ["绝对值"],
        activeSec: 300,
        medianSec: 60,
        multipleOfMedian: 5,
        hintsUsed: 0,
        reasons: ["slow"],
        submittedAt: NOW,
      },
      {
        attemptId: ATT_HINTS,
        questionId: "unit-u2-3",
        stemMd: "写出一个绝对值等于 $3$ 的负数。",
        type: "solve",
        difficulty: 2,
        knowledge: ["绝对值"],
        activeSec: 60,
        medianSec: 60,
        multipleOfMedian: 1,
        hintsUsed: 2,
        reasons: ["hints"],
        submittedAt: NOW,
      },
    ],
    redo: [
      {
        courseId: COURSE_A,
        courseName: "初一数学·上学期",
        unitId: "unit-u1",
        unitTitle: "有理数随堂练习",
        attemptCount: 1,
        redoCount: 0,
        firstScore: 80,
        firstResultCounts: {
          correctCount: 4,
          totalCount: 5,
          pendingCount: 0,
          pendingSelfReviewCount: 0,
        },
        latestSubmittedAt: NOW,
      },
    ],
    wrongQuestions: [
      {
        questionId: "unit-u2-2",
        unitId: "unit-u2",
        unitTitle: "数轴练习",
        type: "choice",
        difficulty: 2,
        knowledge: ["绝对值"],
        stemMd: "数轴上到原点的距离等于 $3$ 的点表示的数是（　）",
        attemptId: ATT_WRONG_1,
        answerText: "A",
        submittedAt: NOW,
      },
      {
        questionId: "unit-u1-3",
        unitId: "unit-u1",
        unitTitle: "有理数随堂练习",
        type: "fill",
        difficulty: 2,
        knowledge: ["有理数加法"],
        stemMd: "计算：$(-3)+7=$ [[4]]。",
        attemptId: ATT_WRONG_2,
        answerText: null,
        submittedAt: NOW,
      },
    ],
    offline: { offlineShare: 2 / 3, activeSecTotal: 990, offlineSecTotal: 60 },
    lectures: [
      {
        lectureId: LECTURE_1,
        title: "第1讲 有理数",
        updatedAt: NOW,
        map: {
          sections: [
            {
              headingIndex: 1,
              level: 2,
              text: "一、正数与负数",
              reached: true,
              rawDwellSec: 120,
              dwellSec: 90,
              expectedSec: 30,
              status: "deep",
            },
            {
              headingIndex: 2,
              level: 2,
              text: "二、数轴",
              reached: true,
              rawDwellSec: 10,
              dwellSec: 10,
              expectedSec: 600,
              status: "skimmed",
            },
            {
              headingIndex: 3,
              level: 2,
              text: "三、绝对值",
              reached: false,
              rawDwellSec: 0,
              dwellSec: 0,
              expectedSec: 30,
              status: "not-reached",
            },
          ],
          folds: [
            {
              docIndex: 0,
              name: "hint",
              hostHeadingIndex: 1,
              opened: false,
              openCount: 0,
              firstOpenOffsetSec: null,
              rawDwellSec: 0,
              dwellSec: 0,
              expectedSec: 10,
              status: "not-opened",
            },
            {
              docIndex: 1,
              name: "solution",
              hostHeadingIndex: 2,
              opened: true,
              openCount: 2,
              firstOpenOffsetSec: 5,
              rawDwellSec: 40,
              dwellSec: 20,
              expectedSec: 30,
              status: "opened-unread",
            },
          ],
          steps: [
            {
              docIndex: 2,
              hostHeadingIndex: 1,
              revealedCount: 2,
              total: 2,
              paceSec: [1, 1],
              status: "rush-skipped",
            },
          ],
          summary: {
            readSec: 100,
            totalVisibleSec: 200,
            sectionCoverage: 2 / 3,
            foldOpenRate: 0.5,
            hintOpenCount: 0,
            solutionOpenCount: 2,
            stepsRushContainerCount: 1,
            stepsTotalContainers: 1,
            stepsOverallMedianPaceSec: 1,
            degradedEventCount: 0,
          },
        },
      },
    ],
    ...overrides,
  };
}

/** 路由地址探针 */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

function renderPage(initialEntry = `/t/students/${S2}`) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/students/:id"
            element={
              <>
                <StudentHomePage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/t/insights" element={<p>overview page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCourses.mockResolvedValue({ courses: [] });
  mockedReports.mockResolvedValue({ reports: [] });
});

describe("StudentHomePage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedStudent.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载学生主页…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复", async () => {
    mockedStudent.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("学生主页加载失败")).toBeInTheDocument();
    mockedStudent.mockResolvedValue(makeStudent());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("讲义阅读地图")).toBeInTheDocument();
  });

  it("404 STUDENT_NOT_FOUND 显示「找不到这名学生」错误页（带返回学生列表）", async () => {
    mockedStudent.mockRejectedValue(
      new ApiError("STUDENT_NOT_FOUND", "学生不存在或不属于该教师", 404),
    );
    renderPage();
    expect(await screen.findByText("找不到这名学生")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回学生列表" })).toHaveAttribute(
      "href",
      "/t/students",
    );
    // 404 是终态：不提供无意义的重试按钮
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });
});

describe("StudentHomePage 指标区", () => {
  it("头部汇总 + 薄弱考点前 5 文字表（按错误数降序，待批单列）", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("讲义阅读地图");

    expect(screen.getByText("李小红")).toBeInTheDocument();
    expect(
      screen.getByText(/正确率 50%（对 3 \/ 已判定 6 题）· 待批 2 题/),
    ).toBeInTheDocument();

    // 薄弱考点文字表（数据按错误数降序，页面取前 5；无已判定显示「—」）
    const knowledgeTable = screen.getByRole("table", {
      name: /薄弱考点前 5/,
    });
    expect(knowledgeTable).toHaveTextContent("数轴");
    expect(knowledgeTable).toHaveTextContent("有理数加法");
    expect(knowledgeTable).toHaveTextContent("50%");
    expect(knowledgeTable).toHaveTextContent("—");
  });

  it("考点超过 5 项时只显示前 5 行（数据按错误数降序传入）", async () => {
    mockedStudent.mockResolvedValue(
      makeStudent({
        knowledge: Array.from({ length: 6 }, (_, i) => ({
          knowledge: `考点${i + 1}`,
          correctCount: 0,
          wrongCount: 10 - i,
          pendingCount: 0,
          judgedCount: 10 - i,
          correctRate: 0,
        })),
      }),
    );
    renderPage();
    const table = await screen.findByRole("table", { name: /薄弱考点前 5/ });
    for (let i = 1; i <= 5; i++) {
      expect(within(table).getByText(`考点${i}`)).toBeInTheDocument();
    }
    expect(within(table).queryByText("考点6")).not.toBeInTheDocument();
  });

  it("考点列表为空时显示空态文案（T-PR1 起无图表，不再有图表空态）", async () => {
    mockedStudent.mockResolvedValue(makeStudent({ knowledge: [] }));
    renderPage();
    expect(
      await screen.findByText("时间范围内还没有已判定的作答，暂无考点统计。"),
    ).toBeInTheDocument();
  });

  it("异常题卡片（D6 两类）与跳作答详情链接", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("用时异常题");

    expect(screen.getByText("用时偏慢")).toBeInTheDocument();
    expect(screen.getByText("提示过多")).toBeInTheDocument();
    expect(screen.getByText(/全域中位数 1 分（约 5 倍）/)).toBeInTheDocument();
    expect(screen.getByText("提示 2 次")).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: "查看作答详情" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/t/data/attempts/${ATT_SLOW}`,
      `/t/data/attempts/${ATT_HINTS}`,
    ]);
  });

  it("错题列表：判错行渲染（单元/题型/学生答案）与整行跳作答详情；空列表空态", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("用时异常题");

    // 两行判错题，整行 Link 跳对应 attempt 详情（aria-label 按题定位）
    const choiceLink = screen.getByRole("link", {
      name: "查看错题 unit-u2-2 的作答详情",
    });
    expect(choiceLink).toHaveAttribute(
      "href",
      `/t/data/attempts/${ATT_WRONG_1}`,
    );
    expect(within(choiceLink).getByText("数轴练习")).toBeInTheDocument();
    expect(within(choiceLink).getByText("学生答案：A")).toBeInTheDocument();

    const fillLink = screen.getByRole("link", {
      name: "查看错题 unit-u1-3 的作答详情",
    });
    expect(fillLink).toHaveAttribute("href", `/t/data/attempts/${ATT_WRONG_2}`);
    // 未作答的判错行 answerText=null →「未作答」（Phase3 D1 口径）
    expect(within(fillLink).getByText("学生答案：未作答")).toBeInTheDocument();

    // 空列表空态
    mockedStudent.mockResolvedValue(makeStudent({ wrongQuestions: [] }));
    renderPage();
    expect(
      await screen.findByText("该生在当前范围内没有判错的题目。"),
    ).toBeInTheDocument();
  });

  it("重做概览与离线作答占比", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("课程练习重做");

    // 错题行与重做表可能同名单元——重做断言限定在表格内
    const redoTable = screen.getByRole("table", {
      name: /课程练习重做概览/,
    });
    expect(within(redoTable).getByText("有理数随堂练习")).toBeInTheDocument();
    expect(within(redoTable).getByText("做对 4 / 5 题")).toBeInTheDocument();
    expect(screen.getByText(/离线 1 分钟 \/ 有效 17 分钟/)).toBeInTheDocument();
  });

  it("「查看该生全部作答」跳作答数据页（携带 studentId）", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("讲义阅读地图");
    expect(
      screen.getByRole("link", { name: /查看该生全部作答/ }),
    ).toHaveAttribute("href", `/t/data?studentId=${S2}`);
  });

  it("「导出给 AI」入口指向导出页并携带 studentId 预填（T4.4）", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("讲义阅读地图");
    expect(screen.getByRole("link", { name: /导出给 AI/ })).toHaveAttribute(
      "href",
      `/t/export?studentId=${S2}`,
    );
  });
});

describe("StudentHomePage 讲义阅读地图（T4.0 §4.4.4）", () => {
  it("目录树逐项状态中文渲染：节三态 + 折叠两态 + steps 连点跳过", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("第1讲 有理数");

    // 节：细读 / 掠过 / 未到达
    expect(screen.getByText("细读")).toBeInTheDocument();
    expect(screen.getByText("掠过")).toBeInTheDocument();
    expect(screen.getByText("未到达")).toBeInTheDocument();

    // 折叠：提示（未打开）、解析（打开未读）；steps：连点跳过 + 进度
    expect(screen.getByText("未打开")).toBeInTheDocument();
    expect(screen.getByText("打开未读")).toBeInTheDocument();
    expect(screen.getByText("连点跳过")).toBeInTheDocument();
    expect(screen.getByText("走到第 2 / 2 步")).toBeInTheDocument();
  });

  it("显示 rawDwell 与 dwell（「含挂机 X」）；显著标注行为推断", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("第1讲 有理数");

    expect(screen.getByText(/含挂机 30 秒/)).toBeInTheDocument();
    expect(screen.getByText(/停留 1 分 30 秒/)).toBeInTheDocument();
    // 显著标注（role=note）
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("行为推断，非注意力测量");
    expect(note).toHaveTextContent("不能据此对学生下注意力结论");
  });

  it("没有阅读记录时空态", async () => {
    mockedStudent.mockResolvedValue(makeStudent({ lectures: [] }));
    renderPage();
    expect(
      await screen.findByText("时间范围内该生还没有讲义阅读记录。"),
    ).toBeInTheDocument();
  });
});

describe("StudentHomePage AI 报告区（T4.7 接入实数据，详见 StudentReportsSection.test）", () => {
  it("空态文案说明报告来源与连接入口（不再说「将在连接 AI 后出现」）", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    expect(await screen.findByText("还没有 AI 报告")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "连接 AI" })).toHaveAttribute(
      "href",
      "/t/connect",
    );
  });
});

describe("StudentHomePage 筛选联动", () => {
  it("URL 初始化的筛选透传接口（days/courseId）；切换天数重查", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage(`/t/students/${S2}?days=7&courseId=${COURSE_A}`);
    await screen.findByText("讲义阅读地图");
    expect(mockedStudent).toHaveBeenLastCalledWith(S2, {
      days: 7,
      courseId: COURSE_A,
    });

    fireEvent.click(screen.getByRole("button", { name: "最近 30 天" }));
    await waitFor(() => {
      expect(mockedStudent).toHaveBeenLastCalledWith(S2, {
        courseId: COURSE_A,
      });
    });
  });
});
