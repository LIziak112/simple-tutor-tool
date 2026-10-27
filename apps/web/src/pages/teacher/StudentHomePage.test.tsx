import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AnalyticsStudentData,
  QuestionReviewRow,
  TeacherAttemptCard,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchAnalyticsStudentApi,
  fetchQuestionReviewApi,
  fetchStudentReports,
  fetchTeacherAttemptsApi,
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
    // T-PR4 Web-2：作答记录区与「错题与存疑」聚合（区域行为在本文件覆盖）
    fetchTeacherAttemptsApi: vi.fn(),
    fetchQuestionReviewApi: vi.fn(),
  };
});

const mockedStudent = vi.mocked(fetchAnalyticsStudentApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);
const mockedReports = vi.mocked(fetchStudentReports);
const mockedAttempts = vi.mocked(fetchTeacherAttemptsApi);
const mockedReview = vi.mocked(fetchQuestionReviewApi);

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

/** 作答卡片工厂（Web-2① 作答记录区行；来源=未挂课程作业） */
function makeAttemptCard(
  overrides: Partial<TeacherAttemptCard> = {},
): TeacherAttemptCard {
  return {
    sourceType: "assignment",
    courseId: null,
    courseName: null,
    assignmentId: "eeeeeeee-0000-4000-8000-000000000001",
    assignmentTitle: "第一次周测",
    unitId: null,
    unitTitle: null,
    attemptNo: 1,
    attemptId: ATT_WRONG_1,
    studentId: S2,
    studentName: "李小红",
    unitCount: 1,
    questionCount: 5,
    status: "submitted",
    scoreAuto: 80,
    scoreFinal: null,
    pendingCount: 0,
    submittedCount: 5,
    startedAt: NOW,
    submittedAt: NOW,
    activeSec: 600,
    ...overrides,
  };
}

/** 「错题与存疑」聚合行工厂（Web-2②） */
function makeReviewRow(
  overrides: Partial<QuestionReviewRow> = {},
): QuestionReviewRow {
  return {
    questionId: "unit-u2-2",
    attemptId: ATT_WRONG_1,
    type: "choice",
    difficulty: 2,
    knowledge: ["绝对值"],
    stemMd: "数轴上到原点的距离等于 $3$ 的点表示的数是（　）",
    finalCorrect: false,
    studentFlag: null,
    hasCorrection: false,
    hasAiHelp: false,
    redoCount: 0,
    lastAt: NOW,
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
  // T-PR4 Web-2 新区默认空（区域行为在各自用例里覆盖）
  mockedAttempts.mockResolvedValue({ attempts: [], total: 0 });
  mockedReview.mockResolvedValue({ total: 0, nextCursor: null, questions: [] });
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

  it("作答记录区（Web-2①）：最近卷列表、进行中卷「已提交 n / 共 m」、整行跳详情", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    mockedAttempts.mockResolvedValue({
      attempts: [
        makeAttemptCard({
          attemptId: ATT_WRONG_1,
          status: "draft",
          submittedAt: null,
          scoreAuto: null,
          submittedCount: 3,
          questionCount: 5,
        }),
        makeAttemptCard({ attemptId: ATT_WRONG_2, status: "submitted" }),
      ],
      total: 2,
    });
    renderPage();
    await screen.findByText(/已提交 3 \/ 共 5/);

    const section = screen.getByRole("region", { name: "作答记录" });
    const rowLinks = within(section)
      .getAllByRole("link")
      .filter((link) =>
        (link.getAttribute("href") ?? "").startsWith("/t/data/attempts/"),
      );
    expect(rowLinks.map((link) => link.getAttribute("href"))).toEqual([
      `/t/data/attempts/${ATT_WRONG_1}`,
      `/t/data/attempts/${ATT_WRONG_2}`,
    ]);
    expect(within(section).getByText(/已提交 3 \/ 共 5/)).toBeInTheDocument();
  });

  it("作答记录区空态", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("该生还没有作答记录。");
    const section = screen.getByRole("region", { name: "作答记录" });
    expect(
      within(section).getByText("该生还没有作答记录。"),
    ).toBeInTheDocument();
  });

  it("错题与存疑（Web-2②）：聚合行判定/自标/订正/AI/重做徽记与跳代表作答详情", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    mockedReview.mockResolvedValue({
      total: 2,
      nextCursor: null,
      questions: [
        makeReviewRow({
          questionId: "q-choice",
          studentFlag: "unsure",
          hasCorrection: true,
          hasAiHelp: true,
          redoCount: 2,
        }),
        makeReviewRow({
          questionId: "q-fill",
          attemptId: ATT_WRONG_2,
          finalCorrect: null,
          stemMd: "计算：$(-3)+7=$ [[4]]。",
        }),
      ],
    });
    renderPage();
    await screen.findByText("重做 2 次");

    const section = screen.getByRole("region", { name: "错题与存疑" });
    const links = within(section).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/t/data/attempts/${ATT_WRONG_1}`,
      `/t/data/attempts/${ATT_WRONG_2}`,
    ]);
    expect(within(section).getAllByText("判错").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(within(section).getByText("待批")).toBeInTheDocument();
    expect(within(section).getByText("自标「不会」")).toBeInTheDocument();
    expect(
      within(section).getAllByText("已订正").length,
    ).toBeGreaterThanOrEqual(1);
    expect(within(section).getByText("问过 AI")).toBeInTheDocument();
    expect(within(section).getByText("重做 2 次")).toBeInTheDocument();
  });

  it("错题与存疑换档：点「自标不会」写 URL ?kind=unsure 并按新 kind 重查", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("当前筛选下没有这一类题目。");
    fireEvent.click(
      within(screen.getByRole("region", { name: "错题与存疑" })).getByRole(
        "button",
        { name: "自标不会" },
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "?kind=unsure",
      );
    });
    const lastCall = mockedReview.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(S2);
    expect(lastCall?.[1].kind).toBe("unsure");
  });

  it("错题与存疑空态与超出单页时的总数提示", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("错题与存疑");
    expect(screen.getByText("当前筛选下没有这一类题目。")).toBeInTheDocument();

    mockedReview.mockResolvedValue({
      total: 60,
      nextCursor: "50",
      questions: Array.from({ length: 50 }, (_, i) =>
        makeReviewRow({ questionId: `q-${i}` }),
      ),
    });
    renderPage();
    expect(
      await screen.findByText(/已显示前 50 题（共 60 题）/),
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

describe("StudentHomePage AI 报告区（T4.7 实数据；T-PR4 起默认折叠）", () => {
  it("默认折叠不取列表（首屏请求 ≤ 4）；展开后才出现报告区", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("讲义阅读地图");
    // 首屏只发 4 个请求：画像 / 课程 / 作答记录 / 错题与存疑——报告列表不取
    expect(mockedReports).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /AI 报告/ }));
    expect(await screen.findByText("还没有 AI 报告")).toBeInTheDocument();
    expect(mockedReports).toHaveBeenCalledTimes(1);
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
