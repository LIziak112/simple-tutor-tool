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
  fetchTeacherCourses,
} from "@/lib/api";
import InsightsStudentPage from "./InsightsStudentPage";

/**
 * /t/insights/students/:id 学生画像组件测试（T4.2）：三态（含 404 STUDENT_NOT_
 * FOUND 错误页）、考点/异常题/重做/离线口径、讲义阅读地图中文渲染（含挂机与
 * 行为推断标注）、AI 报告占位。
 *
 * ECharts 在 jsdom 无法渲染 canvas——mock echarts/core（自有 EChart 封装
 * 直连 echarts/core）：init 桩返回 setOption/resize/dispose 实例，setOption
 * 把 option 的类目/序列落到容器 data-* 属性上供断言
 * （「断言容器与数据装配而非像素」，装配口径另由 chart-options.test 锁定）；
 * 注册源模块（charts/components/renderers）一并置空桩，不拖入真实 echarts。
 */

/** 桩可见的 option 形状（chart-options 构造结果的子集） */
interface StubOption {
  xAxis?: { data?: string[] };
  yAxis?: { data?: string[] };
  series?: { data?: unknown[] }[];
}

vi.mock("echarts/core", () => {
  // 条形图的数据项是 { value, itemStyle }——统一抽成纯数值便于断言
  const plainData = (series: { data?: unknown[] }): unknown[] =>
    (series.data ?? []).map((item) =>
      typeof item === "object" && item !== null && "value" in item
        ? (item as { value: unknown }).value
        : item,
    );
  // init 桩：setOption 把 option 的类目/序列写回容器 data-* 供断言
  const init = vi.fn((el: HTMLElement) => ({
    setOption: vi.fn((option: StubOption) => {
      el.setAttribute(
        "data-categories",
        JSON.stringify(option.yAxis?.data ?? option.xAxis?.data),
      );
      el.setAttribute(
        "data-series",
        JSON.stringify(option.series?.map((series) => plainData(series))),
      );
    }),
    resize: vi.fn(),
    dispose: vi.fn(),
  }));
  return { use: vi.fn(), init };
});
vi.mock("echarts/charts", () => ({ LineChart: {}, BarChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnalyticsStudentApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
  };
});

const mockedStudent = vi.mocked(fetchAnalyticsStudentApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);

const S2 = "22222222-2222-4222-8222-222222222222";
const COURSE_A = "44444444-4444-4444-8444-444444444444";
const LECTURE_1 = "99999999-9999-4999-8999-999999999991";
const ATT_SLOW = "77777777-7777-4777-8777-777777777771";
const ATT_HINTS = "77777777-7777-4777-8777-777777777772";
const ATT_WRONG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ATT_WRONG_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NOW = "2026-09-24T04:00:00.000Z";

/** 画像数据工厂（对齐 seed-demo 李小红构成：异常×2、待批、阅读地图） */
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

function renderPage(initialEntry = `/t/insights/students/${S2}`) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/insights/students/:id"
            element={
              <>
                <InsightsStudentPage />
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
});

describe("InsightsStudentPage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedStudent.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载学生画像…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复", async () => {
    mockedStudent.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("学生画像加载失败")).toBeInTheDocument();
    mockedStudent.mockResolvedValue(makeStudent());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("讲义阅读地图")).toBeInTheDocument();
  });

  it("404 STUDENT_NOT_FOUND 显示「找不到这名学生」错误页（带返回总览）", async () => {
    mockedStudent.mockRejectedValue(
      new ApiError("STUDENT_NOT_FOUND", "学生不存在或不属于该教师", 404),
    );
    renderPage();
    expect(await screen.findByText("找不到这名学生")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回学情总览" })).toHaveAttribute(
      "href",
      "/t/insights",
    );
    // 404 是终态：不提供无意义的重试按钮
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });
});

describe("InsightsStudentPage 指标区", () => {
  it("头部汇总 + 考点表（薄弱在前，待批单列）+ 图表数据装配", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    await screen.findByText("讲义阅读地图");

    expect(screen.getByText("李小红")).toBeInTheDocument();
    expect(
      screen.getByText(/正确率 50%（对 3 \/ 已判定 6 题）· 待批 2 题/),
    ).toBeInTheDocument();

    // 图表数据装配（mock echarts/core 后走真实 option 构造）：
    // 趋势两周 [66.7, null]（第二周无已判定题断线）；考点条形最薄弱（null）在上
    const trend = await screen.findByTestId("analytics-trend-chart");
    expect(trend).toHaveAttribute(
      "data-categories",
      JSON.stringify(["9/14", "9/21"]),
    );
    expect(trend).toHaveAttribute(
      "data-series",
      JSON.stringify([[66.7, null]]),
    );
    const knowledge = await screen.findByTestId("analytics-knowledge-chart");
    expect(knowledge).toHaveAttribute(
      "data-categories",
      JSON.stringify(["有理数加法", "数轴"]),
    );
    expect(knowledge).toHaveAttribute(
      "data-series",
      JSON.stringify([[null, 50]]),
    );

    // 考点表：数轴 50%、有理数加法无已判定（—）且待批 2
    const knowledgeTable = screen.getByRole("table", {
      name: /考点正确率明细/,
    });
    expect(knowledgeTable).toHaveTextContent("数轴");
    expect(knowledgeTable).toHaveTextContent("有理数加法");
    expect(knowledgeTable).toHaveTextContent("50%");
    expect(knowledgeTable).toHaveTextContent("—");
  });

  it("全部考点无已判定题时图表显示空态文案（不渲染 canvas）", async () => {
    mockedStudent.mockResolvedValue(
      makeStudent({
        trend: [
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
            knowledge: "全是待批",
            correctCount: 0,
            wrongCount: 0,
            pendingCount: 3,
            judgedCount: 0,
            correctRate: null,
          },
        ],
      }),
    );
    renderPage();
    expect(
      await screen.findByText("时间范围内还没有已判定的作答，暂无趋势可看。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("时间范围内还没有已判定的作答，暂无考点统计。"),
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
    expect(within(redoTable).getByText("80 分")).toBeInTheDocument();
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
});

describe("InsightsStudentPage 讲义阅读地图（T4.0 §4.4.4）", () => {
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

describe("InsightsStudentPage AI 报告占位（T4.6 后接入）", () => {
  it("空态文案「AI 报告将在连接 AI 后出现」，不做假数据", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage();
    expect(
      await screen.findByText("AI 报告将在连接 AI 后出现"),
    ).toBeInTheDocument();
  });
});

describe("InsightsStudentPage 筛选联动", () => {
  it("URL 初始化的筛选透传接口（days/courseId）；切换天数重查", async () => {
    mockedStudent.mockResolvedValue(makeStudent());
    renderPage(`/t/insights/students/${S2}?days=7&courseId=${COURSE_A}`);
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
