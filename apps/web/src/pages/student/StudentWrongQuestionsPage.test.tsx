import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AttemptStartData,
  StudentCourseListData,
  WrongQuestionCard,
  WrongQuestionsData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindPracticePreferenceAccount,
  getPracticePreference,
} from "@/features/attempt/practice-preference-store";
import {
  filterWrongQuestions,
  filterWrongQuestionsByCourse,
  groupWrongQuestions,
  parseWrongQuestionsUrl,
  wrongKnowledgeOptions,
} from "@/features/student/wrong-questions-ui";
import {
  fetchStudentCoursesApi,
  fetchStudentWrongQuestionsApi,
  startWrongPracticeApi,
} from "@/lib/api";
import StudentWrongQuestionsPage from "./StudentWrongQuestionsPage";

/**
 * /s/wrong 错题本页组件测试（T3.5，D11；2026-10 轮次史改版；2026-10 课程
 * 筛选 + 绝对时间）：两 tab（待复习/已攻克，本地攻克标准从 rounds 计算）、
 * 分组维度（按练习/按时间/按考点，URL 同步）、课程筛选（rounds 任一轮
 * courseId 命中；URL 同步；作用于两 tab 与重练范围）、紧凑行「错 N · 对 M」
 * 与绝对时间、待批轮提示、紧凑行 → 展开完整卡片（含轮次史区块）、旧 URL
 * 参数兼容映射、三态。API 层 mock（页面统一拉全量形态 includeResolved=true；
 * 课程下拉选项走我的课程接口）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentCoursesApi: vi.fn(),
    fetchStudentWrongQuestionsApi: vi.fn(),
    startWrongPracticeApi: vi.fn(),
  };
});

const mockedWrong = vi.mocked(fetchStudentWrongQuestionsApi);
const mockedCourses = vi.mocked(fetchStudentCoursesApi);
const mockedPractice = vi.mocked(startWrongPracticeApi);

const ATTEMPT_A = "66666666-6666-4666-8666-666666666666";
const ATTEMPT_B = "77777777-7777-4777-8777-777777777777";
const ATTEMPT_C = "88888888-8888-4888-8888-888888888888";

/** 两门课程（下拉选项 + rounds.courseId 夹具用） */
const COURSE_A = "12121212-1212-4121-8121-121212121212"; // 初一上
const COURSE_B = "34343434-3434-4343-8343-343434343434"; // 初一下

/** 我的课程接口默认 mock（两门课；个别用例按需覆盖） */
const COURSES_DATA: StudentCourseListData = {
  courses: [
    {
      id: COURSE_A,
      name: "初一上",
      description: null,
      visibleLectureCount: 1,
      visibleUnitCount: 1,
      completedUnitCount: 0,
    },
    {
      id: COURSE_B,
      name: "初一下",
      description: null,
      visibleLectureCount: 1,
      visibleUnitCount: 1,
      completedUnitCount: 0,
    },
  ],
};

/** 轮次工厂（courseId/courseName 默认初一上作业轮） */
function round(
  attemptId: string,
  correct: boolean,
  submittedAt: string,
  sourceTitle = "周末加练",
  courseId: string | null = COURSE_A,
  courseName: string | null = "初一上",
): WrongQuestionCard["rounds"][number] {
  return {
    attemptId,
    sourceType: "assignment",
    correct,
    answered: true,
    studentFlag: null,
    submittedAt,
    sourceTitle,
    courseId,
    courseName,
  };
}

/** 条目工厂（judge 题默认；overrides 换考点/轮次/归属单元） */
function makeQuestion(
  overrides: Partial<WrongQuestionCard> = {},
): WrongQuestionCard {
  return {
    sourceType: "assignment",
    courseId: "12121212-1212-4121-8121-121212121212",
    courseName: "初一上",
    assignmentId: "44444444-4444-4444-8444-444444444444",
    assignmentTitle: "周末加练",
    unitId: null,
    unitTitle: null,
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
    firstAt: "2020-09-20T02:00:00.000Z",
    lastAt: "2020-09-28T02:00:00.000Z",
    rounds: [
      round(ATTEMPT_A, false, "2020-09-20T02:00:00.000Z"),
      round(ATTEMPT_B, false, "2020-09-28T02:00:00.000Z"),
    ],
    wrongCount: 2,
    correctCount: 0,
    pendingCount: 0,
    originUnitId: "unit-有理数",
    originUnitTitle: "有理数",
    ...overrides,
  };
}

/** 错-对：严格标准下待复习、宽松标准下已攻克（攻克标准切换用例的主角） */
const WRONG_THEN_RIGHT = makeQuestion({
  questionId: "q-fill-2",
  type: "fill",
  difficulty: 2,
  knowledge: ["有理数加法"],
  stemMd: "计算：$(-2)+5=$（　）。",
  answers: { kind: "fill", blanks: [["3"]] },
  solutionMd: "$(-2)+5=3$。",
  answerText: "3",
  resolved: true,
  lastAt: "2020-09-29T02:00:00.000Z",
  rounds: [
    round(ATTEMPT_A, false, "2020-09-21T02:00:00.000Z"),
    round(ATTEMPT_B, true, "2020-09-29T02:00:00.000Z"),
  ],
  wrongCount: 1,
  correctCount: 1,
  originUnitId: "unit-有理数加法",
  originUnitTitle: "有理数加法",
});

/** 错-对-对：两种标准下都已攻克 */
const CONQUERED_TWO = makeQuestion({
  questionId: "q-judge-3",
  stemMd: "$0$ 是负数。[[错误]]",
  answers: { kind: "judge", value: false },
  answerText: "对",
  resolved: true,
  lastAt: "2020-09-27T02:00:00.000Z",
  rounds: [
    round(ATTEMPT_A, false, "2020-09-19T02:00:00.000Z"),
    round(ATTEMPT_B, true, "2020-09-25T02:00:00.000Z"),
    round(ATTEMPT_C, true, "2020-09-27T02:00:00.000Z"),
  ],
  wrongCount: 1,
  correctCount: 2,
});

/** 全量形态：默认严格标准下 待复习 = [错-错, 错-对]、已攻克 = [错-对-对] */
const ALL_DATA: WrongQuestionsData = {
  questions: [WRONG_THEN_RIGHT, CONQUERED_TWO, makeQuestion()],
};

/** 跨两门课的题：第 1 轮初一上（作业，错）、第 2 轮初一下（课程练习，对）——任一轮命中即保留 */
const CROSS_COURSE = makeQuestion({
  questionId: "q-cross",
  knowledge: ["数轴"],
  stemMd: "$-1$ 在数轴上位于原点左边。[[正确]]",
  answerText: "错",
  lastAt: "2020-09-26T02:00:00.000Z",
  rounds: [
    round(ATTEMPT_A, false, "2020-09-22T02:00:00.000Z", "周末加练"),
    {
      ...round(
        ATTEMPT_B,
        true,
        "2020-09-26T02:00:00.000Z",
        "有理数小练 · 第 1 次",
        COURSE_B,
        "初一下",
      ),
      sourceType: "course",
    },
  ],
  wrongCount: 1,
  correctCount: 1,
  originUnitId: "unit-数轴",
  originUnitTitle: "数轴",
});

/** 只有错题重练轮的题（rounds.courseId 恒 null）——任意课程筛选下都不出现 */
const WRONG_PRACTICE_ONLY = makeQuestion({
  questionId: "q-wrong-only",
  knowledge: ["绝对值"],
  stemMd: "$|-3|=3$。[[正确]]",
  answerText: "错",
  sourceType: "wrong",
  courseId: null,
  courseName: null,
  assignmentId: null,
  assignmentTitle: null,
  unitId: null,
  unitTitle: null,
  lastAt: "2020-09-30T02:00:00.000Z",
  rounds: [
    {
      ...round(
        ATTEMPT_C,
        false,
        "2020-09-30T02:00:00.000Z",
        "错题重练 · 第 1 次",
        null,
        null,
      ),
      sourceType: "wrong",
    },
  ],
  wrongCount: 1,
  correctCount: 0,
  originUnitId: "unit-绝对值",
  originUnitTitle: "绝对值",
});

/**
 * 课程筛选用数据（严格标准下全在待复习）：初一上 1 题（makeQuestion 两轮全
 * 初一上）+ 跨课程 1 题（初一上/初一下各一轮）+ 纯重练 1 题（无课程轮）。
 * 筛初一下只剩跨课程题；筛未知课程全空。
 */
const COURSE_FILTER_DATA: WrongQuestionsData = {
  questions: [makeQuestion(), CROSS_COURSE, WRONG_PRACTICE_ONLY],
};

/** 公式子树外的正文（KaTeX 的 MathML <annotation> 本就携带 TeX 源码，不算残留） */
function textOutsideMath(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const math of clone.querySelectorAll(".katex")) math.remove();
  return clone.textContent ?? "";
}

/** 路由地址探针（断言 tab/分组写进 URL） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

/** 组卷成功响应（wrong 来源 attempt 摘要；id 由各用例覆盖）——重练入口与选题重练共用 */
const PRACTICE_NEW_ATTEMPT_ID = "99999999-9999-4999-8999-999999999999";
const PRACTICE_SUMMARY: AttemptStartData = {
  id: PRACTICE_NEW_ATTEMPT_ID,
  sourceType: "wrong",
  assignmentId: null,
  lectureId: null,
  courseId: null,
  unitId: null,
  attemptNo: 1,
  status: "draft",
  startedAt: "2020-09-30T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};

/** 带答题页路由的渲染（组卷成功后断言跳 /s/attempts/:id；mutation 不重试）——两 describe 共用 */
function renderPageWithAttemptRoute(initialEntry = "/s/wrong") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/s/wrong"
            element={
              <>
                <StudentWrongQuestionsPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/s/attempts/:attemptId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPage(initialEntry = "/s/wrong") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/s/wrong"
            element={
              <>
                <StudentWrongQuestionsPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // 攻克标准回默认「严格」
  mockedCourses.mockResolvedValue(COURSES_DATA); // 课程下拉默认两门课
});

describe("StudentWrongQuestionsPage 视图与 URL 同步", () => {
  it("默认：待复习 tab + 按练习分组（组头=单元标题+计数）；紧凑行要素；请求只发全量形态", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();

    // 请求：统一全量形态一次（tab/分组本地算，不带 knowledge）
    await waitFor(() =>
      expect(mockedWrong).toHaveBeenCalledWith({ includeResolved: true }),
    );
    // tab 计数（严格标准）：待复习 2 · 已攻克 1
    expect(
      await screen.findByRole("button", { name: "待复习 2 题" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "已攻克 1 题" }),
    ).toBeInTheDocument();
    // 按练习分组：两个单元组头 + 计数（最近活跃的「有理数加法」组在前）
    const groupA = screen.getByRole("heading", {
      name: /有理数加法 · 待复习 1 题/,
    });
    expect(groupA).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /有理数 · 待复习 1 题/ }),
    ).toBeInTheDocument();
    // 紧凑行：题干单行真渲染（公式为 KaTeX、[[正确]] 渲染为空框，公式外正文可读）
    // + 错 N · 对 M + 绝对时间
    expect(await screen.findByText("错 2 · 对 0")).toBeInTheDocument();
    expect(screen.getByText("错 1 · 对 1")).toBeInTheDocument();
    expect(screen.getByText(/是正数。/)).toBeInTheDocument();
    // 绝对时间（formatCnTime：UTC → Asia/Shanghai；不再出现相对时间口径）
    expect(screen.getByText("2020年9月28日 10:00:00")).toBeInTheDocument();
    expect(screen.getByText("2020年9月29日 10:00:00")).toBeInTheDocument();
    expect(
      screen.queryByText(/年前|天前|小时前|分钟前/),
    ).not.toBeInTheDocument();
    // 默认不展开完整卡片（无「我的最近答案」）
    expect(screen.queryByText("我的最近答案：")).not.toBeInTheDocument();
  });

  it("紧凑行题干真渲染（#6972 第 1 条）：公式为 KaTeX 而非 LaTeX 原文、图片/表格降级为占位、[[答案]] 为空框且不显示答案、按钮内无块级/交互元素", async () => {
    mockedWrong.mockResolvedValue({
      questions: [
        makeQuestion({
          questionId: "q-rich",
          type: "fill",
          stemMd: [
            "如图，![三角形 ABC](blobs/tri.png)",
            "",
            "| 边 | 长 |",
            "| - | - |",
            "| a | 3 |",
            "",
            "解方程 $\\frac{1}{2}x+3=5$，得 $x=$ [[4]]。",
          ].join("\n"),
          answers: { kind: "fill", blanks: [["4"]] },
          answerText: "2",
        }),
      ],
    });
    renderPage();
    const row = await screen.findByRole("button", { name: /错 2 · 对 0/ });
    const stem = row.querySelector(".rich-markdown");
    if (!(stem instanceof HTMLElement)) {
      throw new Error("紧凑行缺少题干真渲染容器 .rich-markdown");
    }
    // 公式：KaTeX 输出（两处公式各一份）；公式子树外的正文不残留 \frac / $ 原文
    //（KaTeX 自带的 MathML <annotation> 携带 TeX 源码供读屏且视觉隐藏，不算残留）
    expect(stem.querySelectorAll(".katex")).toHaveLength(2);
    const prose = textOutsideMath(stem);
    expect(prose).not.toContain("\\frac");
    expect(prose).not.toContain("$");
    // 图片 / 表格：降级为占位，不残留 Markdown 记号（![…](…)、竖线）
    expect(stem.querySelector("img")).toBeNull();
    expect(stem.querySelector("table")).toBeNull();
    expect(prose).not.toContain("![");
    expect(prose).not.toContain("|");
    expect(stem).toHaveTextContent("[图]");
    expect(stem).toHaveTextContent("[表格]");
    // 填空：空框占位，答案原文不显示（与展开卡同一 blank 指令）
    expect(stem.querySelector('[data-testid="blank"]')).not.toBeNull();
    expect(prose).not.toContain("4");
    // 单行收敛：按钮内只允许短语内容，不得出现块级 / 交互元素
    expect(
      stem.querySelector(
        "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, a, input, hr",
      ),
    ).toBeNull();
    // 正文仍完整可读
    expect(stem).toHaveTextContent(/如图，/);
    expect(stem).toHaveTextContent(/解方程/);
  });

  it("点击紧凑行展开完整卡片：答案/详解折叠/轮次史（统计 + 每轮一行 + 绝对时间）；再点收起", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();
    const row = await screen.findByRole("button", {
      name: /错 2 · 对 0/,
    });
    fireEvent.click(row);
    // 完整卡片：首次标记 + 我的最近答案 + 正确答案
    expect(screen.getByText("首次做错")).toBeInTheDocument();
    expect(screen.getByText("我的最近答案：")).toBeInTheDocument();
    expect(screen.getByText("正确答案：")).toBeInTheDocument();
    // 轮次史区块：汇总 + 每轮一行（第 1/2 轮 · 做错 · 来源标题 · 绝对时间）
    expect(screen.getByText("已做错 2 次 · 做对 0 次")).toBeInTheDocument();
    expect(screen.getAllByText("第 1 轮").length).toBe(1);
    expect(screen.getAllByText("第 2 轮").length).toBe(1);
    expect(screen.getAllByText("做错").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/周末加练/).length).toBeGreaterThanOrEqual(2);
    // 每轮一行可点（2026-10）：链接 → /s/attempts/:attemptId 回看该轮作答
    expect(
      screen.getByRole("link", { name: "查看第 1 轮作答：周末加练" }),
    ).toHaveAttribute("href", `/s/attempts/${ATTEMPT_A}`);
    expect(
      screen.getByRole("link", { name: "查看第 2 轮作答：周末加练" }),
    ).toHaveAttribute("href", `/s/attempts/${ATTEMPT_B}`);
    // 每轮时间与页脚「最近来源」时间都是绝对时间：9-20 只在轮次行；9-28 在
    // 紧凑行 + 轮次行 + 页脚共 3 处
    expect(screen.getAllByText("2020年9月20日 10:00:00").length).toBe(1);
    expect(screen.getAllByText("2020年9月28日 10:00:00").length).toBe(3);
    // 待批轮提示：pendingCount=0 不显示
    expect(screen.queryByText(/另有 \d+ 轮待老师批改/)).not.toBeInTheDocument();
    // 详解默认折叠
    expect(screen.queryByText(/大于/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /查看详解/ }));
    expect(
      await screen.findByText(/大于/, {}, { timeout: 3000 }),
    ).toBeVisible();
    // 收起
    fireEvent.click(screen.getByRole("button", { name: /错 2 · 对 0/ }));
    expect(screen.queryByText("我的最近答案：")).not.toBeInTheDocument();
  });

  it("tab 切换写 URL（tab=conquered）且已攻克分区组头计数换口径", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();
    await screen.findByRole("button", { name: "待复习 2 题" });

    fireEvent.click(screen.getByRole("button", { name: "已攻克 1 题" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "tab=conquered",
      ),
    );
    // 已攻克分区：组头「已攻克 x 题」；成员 = 错-对-对 那道
    expect(
      screen.getByRole("heading", { name: /有理数 · 已攻克 1 题/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/是负数。/)).toBeInTheDocument();
    // 待复习那两道不在
    expect(screen.queryByText(/是正数。/)).not.toBeInTheDocument();
    expect(screen.queryByText(/计算：/)).not.toBeInTheDocument();
  });

  it("分组维度切换写 URL：按时间出现时间桶组头、按考点出现考点组头", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();
    await screen.findByRole("button", { name: "按练习" });

    fireEvent.click(screen.getByRole("button", { name: "按时间" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "group=time",
      ),
    );
    // 夹具 lastAt 都在 2026-09（相对测试时钟为「更早」桶；断言组头出现即可）
    expect(
      await screen.findByRole("heading", { name: /更早 · 待复习 2 题/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "按考点" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "group=knowledge",
      ),
    );
    expect(
      await screen.findByRole("heading", {
        name: /有理数的概念 · 待复习 1 题/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /有理数加法 · 待复习 1 题/ }),
    ).toBeInTheDocument();
    // 多考点归组说明
    expect(screen.getByText(/多考点的题按第一个考点归组/)).toBeInTheDocument();
  });

  it("攻克标准切换（严格 → 做对 1 次）：错-对 的题移进已攻克，写 localStorage", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();
    await screen.findByRole("button", { name: "待复习 2 题" });

    // 严格（默认）：错-对 的题在待复习分组里
    expect(screen.getByText(/计算：/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "做对 1 次" }));
    // 宽松：待复习剩 1（错-错）、已攻克变 2（错-对 + 错-对-对）
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "待复习 1 题" })).toBeVisible(),
    );
    expect(
      screen.getByRole("button", { name: "已攻克 2 题" }),
    ).toBeInTheDocument();
    expect(localStorage.getItem("tutor.wrong-mastery-standard")).toBe(
      "lenient",
    );
    // 切回严格恢复
    fireEvent.click(
      screen.getByRole("button", { name: "连续做对 2 次（默认）" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "待复习 2 题" })).toBeVisible(),
    );
    expect(localStorage.getItem("tutor.wrong-mastery-standard")).toBe("strict");
  });

  it("旧 URL 参数兼容：includeResolved=true 映射已攻克 tab；knowledge 现为综合筛选参数（2026-10）直接生效", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage("/s/wrong?includeResolved=true&knowledge=有理数的概念");
    expect(
      await screen.findByRole("button", {
        name: "已攻克 1 题",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    // 已攻克成员 CONQUERED_TWO 的考点即「有理数的概念」→ 筛选不改变该分区视图
    expect(
      screen.getByRole("heading", { name: /有理数 · 已攻克 1 题/ }),
    ).toBeInTheDocument();
  });
});

describe("StudentWrongQuestionsPage 三态", () => {
  it("加载中显示骨架", async () => {
    mockedWrong.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载错题本…")).toBeInTheDocument();
  });

  it("空列表：还没有错题；有错题但当前分区空：按 tab 给解释文案", async () => {
    mockedWrong.mockResolvedValue({ questions: [] });
    renderPage();
    expect(await screen.findByText("还没有错题")).toBeInTheDocument();

    // 严格标准下已攻克分区为空（夹具全在待复习）
    mockedWrong.mockResolvedValue({
      questions: [makeQuestion()],
    });
    renderPage("/s/wrong?tab=conquered");
    expect(await screen.findByText("还没有攻克过的错题")).toBeInTheDocument();
    expect(
      screen.getByText(/按当前攻克标准（连续做对 2 次）还没有攻克的错题/),
    ).toBeInTheDocument();
  });

  it("加载失败显示错误与重试", async () => {
    mockedWrong.mockRejectedValue(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("错题本加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("StudentWrongQuestionsPage 课程筛选（2026-10）", () => {
  it("选课程后列表/tab 计数/重练全部只剩该课程的题并写 URL；改回全部课程恢复", async () => {
    mockedWrong.mockResolvedValue(COURSE_FILTER_DATA);
    renderPage();
    await screen.findByText("错 2 · 对 0"); // 列表就绪
    // 默认全部课程：三题都在（严格标准下全在待复习）
    expect(
      screen.getByRole("button", { name: "待复习 3 题" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重练全部（3 题）" }),
    ).toBeEnabled();
    // 下拉选项 = 全部课程 + 两门课（我的课程接口）
    const select = screen.getByLabelText("课程");
    expect(select).toHaveDisplayValue("全部课程");
    expect(screen.getByRole("option", { name: "初一上" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "初一下" })).toBeInTheDocument();

    // 选初一下：只剩跨课程题（rounds 第 2 轮命中）；纯初一上/纯重练的题消失
    fireEvent.change(select, { target: { value: COURSE_B } });
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `courseId=${COURSE_B}`,
      ),
    );
    expect(
      screen.getByRole("button", { name: "待复习 1 题" }),
    ).toBeInTheDocument();
    // 两个 tab 的计数都受课程筛选作用（跨课程题错-对、严格标准下待复习）
    expect(
      screen.getByRole("button", { name: "已攻克 0 题" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/在数轴上位于原点左边/)).toBeInTheDocument();
    expect(screen.queryByText(/是正数。/)).not.toBeInTheDocument();
    // 纯重练题（题干只有公式 + 句号）：按其独有的最近时间断言不在
    expect(
      screen.queryByText("2020年9月30日 10:00:00"),
    ).not.toBeInTheDocument();
    // 页头「重练全部」计数跟随筛选后的集合
    expect(
      screen.getByRole("button", { name: "重练全部（1 题）" }),
    ).toBeEnabled();

    // 改回全部课程：URL 参数移除、列表与计数恢复
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "待复习 3 题" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "courseId=",
    );
  });

  it("深链 courseId 直接生效；课程列表外的 courseId 给占位选项且空态指向筛选", async () => {
    mockedWrong.mockResolvedValue(COURSE_FILTER_DATA);
    renderPage(`/s/wrong?courseId=${COURSE_B}`);
    // 不经交互即筛好：只剩跨课程题，下拉回显初一下
    expect(await screen.findByText(/在数轴上位于原点左边/)).toBeInTheDocument();
    expect(screen.getByLabelText("课程")).toHaveValue(COURSE_B);
    expect(screen.queryByText(/是正数。/)).not.toBeInTheDocument();
    cleanup();

    // 课程列表外的 courseId（课程已归档/已移出成员）：占位选项兜底 + 空态归因筛选
    const unknownId = "00000000-0000-4000-8000-000000000000";
    renderPage(`/s/wrong?courseId=${unknownId}`);
    expect(
      await screen.findByRole("option", { name: "已不在我的课程" }),
    ).toBeInTheDocument();
    expect(screen.getByText("这门课暂无待复习的错题")).toBeInTheDocument();
    expect(screen.getByText(/可以换一门课程试试/)).toBeInTheDocument();
  });

  it("课程接口失败/为空不阻塞列表：下拉只显示全部课程", async () => {
    mockedCourses.mockResolvedValue({ courses: [] });
    mockedWrong.mockResolvedValue(COURSE_FILTER_DATA);
    renderPage();
    await screen.findByRole("button", { name: "待复习 3 题" });
    expect(
      screen.getByRole("option", { name: "全部课程" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "初一上" }),
    ).not.toBeInTheDocument();
  });

  it("pendingCount>0 的题展开卡轮次史尾部显示「另有 N 轮待老师批改」", async () => {
    mockedWrong.mockResolvedValue({
      questions: [makeQuestion({ pendingCount: 2 })],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /错 2 · 对 0/ }));
    expect(screen.getByText("另有 2 轮待老师批改")).toBeInTheDocument();
  });
});

describe("wrong-questions-ui 纯函数", () => {
  it("parseWrongQuestionsUrl：默认待复习+按练习+全部课程+无筛选；tab/group/courseId 解析；旧参数映射；综合筛选（多选考点 + 自由输入数字）解析与非法回默认", () => {
    expect(parseWrongQuestionsUrl(new URLSearchParams(""))).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: null,
      wrongMin: null,
    });
    expect(
      parseWrongQuestionsUrl(
        new URLSearchParams("tab=conquered&group=time&courseId=abc"),
      ),
    ).toEqual({
      tab: "conquered",
      group: "time",
      courseId: "abc",
      knowledge: [],
      days: null,
      wrongMin: null,
    });
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("includeResolved=true")),
    ).toEqual({
      tab: "conquered",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: null,
      wrongMin: null,
    });
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("tab=what&group=nope")),
    ).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: null,
      wrongMin: null,
    });
    // courseId 空串 = 未选（全部课程）
    expect(parseWrongQuestionsUrl(new URLSearchParams("courseId="))).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: null,
      wrongMin: null,
    });
    // 综合筛选（2026-10）：knowledge 逗号分隔多选（去空白/去重），days/wrongMin
    // 支持自由输入整数（不再只认预设档位）
    expect(
      parseWrongQuestionsUrl(
        new URLSearchParams(
          "knowledge=数轴, 有理数加法,数轴&days=30&wrongMin=2",
        ),
      ),
    ).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: ["数轴", "有理数加法"],
      days: 30,
      wrongMin: 2,
    });
    // 自定义档位：days=45 / wrongMin=5 照常生效
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("days=45&wrongMin=5")),
    ).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: 45,
      wrongMin: 5,
    });
    // 越界/非整数回默认（深链手改不报错）
    expect(
      parseWrongQuestionsUrl(
        new URLSearchParams("days=0&wrongMin=abc&knowledge=,,"),
      ),
    ).toEqual({
      tab: "pending",
      group: "unit",
      courseId: null,
      knowledge: [],
      days: null,
      wrongMin: null,
    });
  });

  it("filterWrongQuestions（2026-10 综合）：课程 × 考点（多选 OR）× 时间 × 错次逐条件收窄；时间按北京自然日含今天", () => {
    const now = new Date("2026-10-27T04:00:00.000Z"); // 北京 10-27 12:00
    const recent = makeQuestion({
      questionId: "q-recent",
      lastAt: "2026-10-26T20:00:00.000Z", // 北京 10-27 04:00（今天凌晨）
      wrongCount: 2,
    });
    const weekAgo = makeQuestion({
      questionId: "q-week",
      knowledge: ["数轴"],
      lastAt: "2026-10-19T02:00:00.000Z", // 北京 10-19，30 天内、7 天外
      wrongCount: 2,
    });
    const old = makeQuestion({
      questionId: "q-old",
      knowledge: ["有理数加法"],
      lastAt: "2026-09-01T02:00:00.000Z", // 30 天外
      wrongCount: 3,
    });
    const questions = [recent, weekAgo, old];
    // 仅时间 7 天：只剩今天判定的 recent（含今天零点起）
    expect(
      filterWrongQuestions(
        questions,
        { courseId: null, knowledge: [], days: 7, wrongMin: null },
        now,
      ).map((q) => q.questionId),
    ).toEqual(["q-recent"]);
    // 仅错次 ≥3：只剩 old
    expect(
      filterWrongQuestions(
        questions,
        { courseId: null, knowledge: [], days: null, wrongMin: 3 },
        now,
      ).map((q) => q.questionId),
    ).toEqual(["q-old"]);
    // 单考点 × 时间组合：数轴 ∩ 30 天 → week
    expect(
      filterWrongQuestions(
        questions,
        { courseId: null, knowledge: ["数轴"], days: 30, wrongMin: null },
        now,
      ).map((q) => q.questionId),
    ).toEqual(["q-week"]);
    // 考点多选（OR 语义）：数轴 ∪ 有理数加法 → week + old（不受时间条件）
    expect(
      filterWrongQuestions(
        questions,
        {
          courseId: null,
          knowledge: ["数轴", "有理数加法"],
          days: null,
          wrongMin: null,
        },
        now,
      ).map((q) => q.questionId),
    ).toEqual(["q-week", "q-old"]);
    // 全空条件：原样返回（同一引用）
    expect(
      filterWrongQuestions(
        questions,
        { courseId: null, knowledge: [], days: null, wrongMin: null },
        now,
      ),
    ).toBe(questions);
    // 课程条件沿用 filterWrongQuestionsByCourse 口径（初一下 → 跨课程题）
    expect(
      filterWrongQuestions(
        COURSE_FILTER_DATA.questions,
        { courseId: COURSE_B, knowledge: [], days: null, wrongMin: null },
        now,
      ).map((q) => q.questionId),
    ).toEqual(["q-cross"]);
  });

  it("wrongKnowledgeOptions：按题数降序、同数中文名稳定排序；多考点题每个考点各计一次", () => {
    const q1 = makeQuestion({ knowledge: ["有理数的概念"] });
    const q2 = makeQuestion({ knowledge: ["有理数的概念", "数轴"] });
    const q3 = makeQuestion({ knowledge: ["数轴"] });
    // 同为 2 题：中文排序「数轴」在前（localeCompare zh-Hans-CN 拼音序）
    expect(wrongKnowledgeOptions([q1, q2, q3])).toEqual([
      { name: "数轴", count: 2 },
      { name: "有理数的概念", count: 2 },
    ]);
  });

  it("filterWrongQuestionsByCourse：rounds 任一轮命中即保留；null 轮不参与命中；全部课程原样返回", () => {
    const questions = COURSE_FILTER_DATA.questions;
    // 全部课程：原样返回（同一引用，不复制列表）
    expect(filterWrongQuestionsByCourse(questions, null)).toBe(questions);
    // 筛初一上：两轮全初一上的题 + 跨课程题（第 1 轮命中）
    expect(
      filterWrongQuestionsByCourse(questions, COURSE_A).map(
        (q) => q.questionId,
      ),
    ).toEqual(["q-judge-1", "q-cross"]);
    // 筛初一下：只剩跨课程题（第 2 轮命中）；纯重练轮（null）的题不出现
    expect(
      filterWrongQuestionsByCourse(questions, COURSE_B).map(
        (q) => q.questionId,
      ),
    ).toEqual(["q-cross"]);
    // 未知课程：全空
    expect(
      filterWrongQuestionsByCourse(
        questions,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toEqual([]);
  });

  it("groupWrongQuestions：时间桶按固定顺序、空桶不出现；未归类单元落「未归类」", () => {
    const now = new Date("2026-10-08T04:00:00.000Z"); // 北京时间 10-08 12:00（周四）
    const thisWeek = makeQuestion({
      questionId: "q-week",
      lastAt: "2026-10-07T02:00:00.000Z", // 北京 10-07 10:00，本周（周一 10-05 起）
    });
    const lastWeek = makeQuestion({
      questionId: "q-lastweek",
      lastAt: "2026-09-30T02:00:00.000Z", // 上周
    });
    const earlier = makeQuestion({
      questionId: "q-earlier",
      lastAt: "2026-08-01T02:00:00.000Z", // 更早（9 月不属于本月 10 月）
    });
    const orphans = makeQuestion({
      questionId: "q-orphan",
      originUnitId: null,
      originUnitTitle: null,
      lastAt: "2026-10-06T02:00:00.000Z",
    });
    const timeGroups = groupWrongQuestions(
      [earlier, thisWeek, lastWeek, orphans],
      "time",
      now,
    );
    expect(timeGroups.map((group) => group.title)).toEqual([
      "本周",
      "上周",
      "更早",
    ]);
    // 组内保持入参顺序（页面场景下即服务端 lastAt 倒序）
    expect(timeGroups[0]?.questions.map((q) => q.questionId)).toEqual([
      "q-week",
      "q-orphan",
    ]);
    // 按练习：未归类组存在
    const unitGroups = groupWrongQuestions([orphans], "unit", now);
    expect(unitGroups[0]?.title).toBe("未归类");
  });
});

describe("StudentWrongQuestionsPage 重练入口（2026-10）", () => {
  // NEW_ATTEMPT_ID / PRACTICE_SUMMARY / renderPageWithAttemptRoute 提升在文件
  // 顶层（与「选题重练」describe 共用）
  const NEW_ATTEMPT_ID = PRACTICE_NEW_ATTEMPT_ID;

  it("按钮示数：页头「重练全部」= 当前 tab 题数；组头「重练本组」= 组内题数；空 tab 禁用", async () => {
    // 只有待复习一题（错-错）：已攻克为空 → 切过去后重练全部（0 题）禁用
    mockedWrong.mockResolvedValue({
      questions: [makeQuestion()],
    });
    renderPageWithAttemptRoute();
    expect(
      await screen.findByRole("button", { name: "重练全部（1 题）" }),
    ).toBeEnabled();
    // 按练习分组单组 → 一个组头按钮，示数 1
    expect(
      screen.getByRole("button", { name: "重练本组（1 题）" }),
    ).toBeEnabled();

    // 切已攻克（空 tab）：按钮示 0 并禁用（空态区无组头按钮）
    fireEvent.click(screen.getByRole("button", { name: "已攻克 0 题" }));
    const emptyPractice = screen.getByRole("button", { name: /重练全部/ });
    expect(emptyPractice).toHaveTextContent("重练全部（0 题）");
    expect(emptyPractice).toBeDisabled();
  });

  it("点击「重练全部」→ 按列表序提交 questionIds → 成功后跳 /s/attempts/:id", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    mockedPractice.mockResolvedValue({
      ...PRACTICE_SUMMARY,
      id: NEW_ATTEMPT_ID,
    });
    renderPageWithAttemptRoute();
    await screen.findByRole("button", { name: "重练全部（2 题）" });
    fireEvent.click(screen.getByRole("button", { name: "重练全部（2 题）" }));
    // 顺序 = 当前 tab 列表序（q-fill-2 在前、q-judge-1 在后）；M3-D1.5 建卷
    // 请求显式携带 workflowVersion=1；M5-D2 偏好未设置时不发 feedbackMode
    await waitFor(() => {
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-fill-2", "q-judge-1"],
        { workflowVersion: 1 },
        // #6980-2：范围快照随请求上报（重练全部、无课程筛选 → 无 courseName）
        { kind: "all" },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `/s/attempts/${NEW_ATTEMPT_ID}`,
      );
    });
  });

  it("M3-D1.5：偏好为 after_attempt 时，重练请求按点击时刻的偏好携带", async () => {
    // 预置该账号持久化偏好为「交卷后公布」（D1 无 feedback UI，直接写契约
    // 完整形态后重绑读取），重练请求应按点击时刻的偏好携带
    const key = `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "wrong-pref-user"])}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        layout: "list",
        feedback: "after_attempt",
        keyboardShortcuts: true,
      }),
    );
    bindPracticePreferenceAccount(null);
    bindPracticePreferenceAccount("wrong-pref-user");
    expect(getPracticePreference().feedback).toBe("after_attempt");
    mockedWrong.mockResolvedValue(ALL_DATA);
    mockedPractice.mockResolvedValue({
      ...PRACTICE_SUMMARY,
      id: NEW_ATTEMPT_ID,
    });
    renderPageWithAttemptRoute();
    await screen.findByRole("button", { name: "重练全部（2 题）" });
    fireEvent.click(screen.getByRole("button", { name: "重练全部（2 题）" }));
    await waitFor(() => {
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-fill-2", "q-judge-1"],
        {
          workflowVersion: 1,
          feedbackMode: "after_attempt",
        },
        // #6980-2：范围快照随请求上报（重练全部、无课程筛选 → 无 courseName）
        { kind: "all" },
      );
    });
    // 模块级 store 跨用例残留：解绑回默认，避免影响同文件其他用例
    bindPracticePreferenceAccount(null);
  });

  it("点击「重练本组」只提交该组题目；组卷失败显示错误横幅，重试成功后照常跳转", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    mockedPractice
      .mockRejectedValueOnce(new Error("这些题目不在你的错题本里"))
      .mockResolvedValueOnce({
        ...PRACTICE_SUMMARY,
        id: NEW_ATTEMPT_ID,
      });
    renderPageWithAttemptRoute();
    // 首组 = 有理数加法（lastAt 最新），组内只 q-fill-2；两组各一题 → 取第一个
    const groupButtons = await screen.findAllByRole("button", {
      name: "重练本组（1 题）",
    });
    expect(groupButtons).toHaveLength(2);
    fireEvent.click(groupButtons[0] as HTMLElement);
    await waitFor(() => {
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-fill-2"],
        { workflowVersion: 1 },
        // #6980-2：范围快照（按练习分组 → dimension:"unit" + 组名，无课程筛选）
        { kind: "group", dimension: "unit", groupTitle: "有理数加法" },
      );
    });
    // 失败：错误横幅出现（含服务端信息），页面仍留在错题本
    expect(await screen.findByRole("alert")).toHaveTextContent("重练组卷失败");
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/s/wrong");
    // 重试（第二次 mock 已换成功）→ 跳答题页
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `/s/attempts/${NEW_ATTEMPT_ID}`,
      );
    });
  });
});

describe("StudentWrongQuestionsPage 综合筛选（2026-10）", () => {
  /** 近期题（最近 2 天内判定；错 2 次）与古题（2020-09；错 2 / 错 1 次） */
  function filterData(): WrongQuestionsData {
    const recent = makeQuestion({
      questionId: "q-recent",
      knowledge: ["有理数的概念"],
      lastAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      rounds: [
        round(
          ATTEMPT_A,
          false,
          new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
        ),
        round(
          ATTEMPT_B,
          false,
          new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
        ),
      ],
      wrongCount: 2,
      correctCount: 0,
    });
    const oldWrong2 = makeQuestion({
      questionId: "q-old-2",
      knowledge: ["有理数加法"],
      wrongCount: 2,
    });
    const oldWrong1 = makeQuestion({
      questionId: "q-old-1",
      knowledge: ["数轴"],
      wrongCount: 1,
    });
    return { questions: [recent, oldWrong2, oldWrong1] };
  }

  it("考点筛选（输入 + 建议多选）：datalist 建议来自当前列表（带计数），回车添加后列表/计数收窄并写 URL，chips 可单清", async () => {
    mockedWrong.mockResolvedValue(filterData());
    renderPage();
    const knowledgeInput = await screen.findByLabelText("考点");
    // datalist 建议：当前列表的三个考点（计数各 1，按频次/名称稳定排序）——
    // 输入框随页面先渲染，建议随数据到达（waitFor 等齐）
    const datalist = document.getElementById("wrong-knowledge-options");
    expect(datalist).not.toBeNull();
    await waitFor(() => {
      expect(datalist?.children).toHaveLength(3);
    });
    expect(datalist?.children[0]?.getAttribute("value")).toBe("数轴");
    // 输入「有理数的概念」回车添加 → 只剩 q-recent（错 2 · 对 0）
    fireEvent.change(knowledgeInput, {
      target: { value: "有理数的概念" },
    });
    fireEvent.keyDown(knowledgeInput, { key: "Enter" });
    expect(await screen.findByText("错 2 · 对 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待复习 1 题" })).toBeTruthy();
    expect(screen.getByTestId("location-probe")).toHaveTextContent(
      "knowledge=",
    );
    expect(knowledgeInput).toHaveValue("");
    // 再添加「数轴」（多选 OR）→ q-old-1 也回来（数轴、2020 年、错 1 次）
    fireEvent.change(knowledgeInput, { target: { value: "数轴" } });
    fireEvent.keyDown(knowledgeInput, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "待复习 2 题" }),
    ).toBeTruthy();
    // 多选 chips 可单清：清掉「数轴」→ 回到 1 题
    fireEvent.click(screen.getByRole("button", { name: "清除考点「数轴」" }));
    expect(
      await screen.findByRole("button", { name: "待复习 1 题" }),
    ).toBeTruthy();
    // 重练全部范围跟随筛选（只提交筛后题）
    expect(
      screen.getByRole("button", { name: "重练全部（1 题）" }),
    ).toBeTruthy();
  });

  it("时间 + 错次组合（综合筛选）：最近 30 天 × 错 2 次及以上只剩近期题；URL 同步、chips 可单清；筛选条清除全部连课程一起清", async () => {
    mockedWrong.mockResolvedValue(filterData());
    // 带课程深链（filterData 全部 rounds 都在 COURSE_A，课程不收窄但 URL 携带）
    renderPage(`/s/wrong?courseId=${COURSE_A}`);
    await screen.findByLabelText("考点");
    fireEvent.change(screen.getByLabelText("时间"), {
      target: { value: "30" },
    });
    // 最近 30 天：只剩 q-recent（2020 年的题全部排除）
    expect(await screen.findByText("错 2 · 对 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待复习 1 题" })).toBeTruthy();

    // 叠加错次 ≥2：q-old-2（时间外）不回来；q-old-1（错 1 次）被错次排除
    fireEvent.change(screen.getByLabelText("错次"), {
      target: { value: "2" },
    });
    expect(screen.getByRole("button", { name: "待复习 1 题" })).toBeTruthy();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("days=30");
    expect(screen.getByTestId("location-probe")).toHaveTextContent(
      "wrongMin=2",
    );

    // 自定义档位（实测反馈）：时间改 45 天照样生效，chip 标签动态生成
    fireEvent.change(screen.getByLabelText("时间"), {
      target: { value: "45" },
    });
    expect(await screen.findByText("最近 45 天")).toBeTruthy();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("days=45");

    // 活跃筛选 chips（以单清按钮锚定）+ 一键清除：清掉时间后 q-old-2（错 2）回来
    expect(
      screen.getByRole("button", { name: "清除时间筛选" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "清除错次筛选" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除时间筛选" }));
    expect(screen.getByRole("button", { name: "待复习 2 题" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除全部筛选" }));
    expect(screen.getByRole("button", { name: "待复习 3 题" })).toBeTruthy();
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent("days=");
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "wrongMin=",
    );
    // 评审修复：筛选条「清除全部筛选」与空态按钮同一范围——课程也一并清
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "courseId=",
    );
  });

  it("筛选后空态归因筛选并给「清除全部筛选」；深链参数直接生效", async () => {
    mockedWrong.mockResolvedValue(filterData());
    renderPage(
      `/s/wrong?courseId=${COURSE_A}&knowledge=%E6%95%B0%E8%BD%B4&days=30&wrongMin=2`,
    );
    // 深链：数轴（q-old-1，2020 年 + 错 1 次）被时间与错次滤掉 → 空态
    expect(await screen.findByText("当前筛选下没有错题")).toBeInTheDocument();
    // 筛选条与空态各有一个「清除全部筛选」；点**空态**里的那个（DOM 靠后，
    // 索引 [1]——评审修复：此前点成筛选条按钮，空态按钮路径零覆盖）
    fireEvent.click(
      screen.getAllByRole("button", { name: "清除全部筛选" })[1] as HTMLElement,
    );
    expect(
      await screen.findByRole("button", { name: "待复习 3 题" }),
    ).toBeInTheDocument();
    // 空态按钮清全部（课程 + 综合）
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "courseId=",
    );
  });
});

describe("StudentWrongQuestionsPage 选题重练（2026-10）", () => {
  // NEW_ATTEMPT_ID / PRACTICE_SUMMARY / renderPageWithAttemptRoute 复用文件顶层定义
  const NEW_ATTEMPT_ID = PRACTICE_NEW_ATTEMPT_ID;

  /** 同单元两题 + 另一单元一题（全在待复习）：组头全选用 */
  function selectionData(): WrongQuestionsData {
    const sameUnitA = makeQuestion();
    const sameUnitB = makeQuestion({
      questionId: "q-judge-2",
      stemMd: "$-2$ 是正数。[[错误]]",
    });
    const otherUnit = makeQuestion({
      questionId: "q-cross-unit",
      knowledge: ["数轴"],
      originUnitId: "unit-数轴",
      originUnitTitle: "数轴",
      lastAt: "2020-09-25T02:00:00.000Z",
    });
    return { questions: [sameUnitA, sameUnitB, otherUnit] };
  }

  it("进入选题模式：行变复选、点选两题、底部操作条示数、重练已选按列表序提交并带 selection 范围", async () => {
    mockedWrong.mockResolvedValue(selectionData());
    mockedPractice.mockResolvedValue(PRACTICE_SUMMARY);
    renderPageWithAttemptRoute();
    fireEvent.click(await screen.findByRole("button", { name: "选题重练" }));
    // 行变为 checkbox（aria-checked=false）
    const cb1 = screen.getByRole("checkbox", { name: /q-judge-1/ });
    expect(cb1).toHaveAttribute("aria-checked", "false");
    // 选题模式下隐藏常规重练入口，出现操作条（0 题禁用）
    expect(
      screen.queryByRole("button", { name: /重练全部/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("已选 0 题")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重练已选（0 题）" }),
    ).toBeDisabled();
    // 点选两题（列表序 q-judge-1、q-judge-2）
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-1/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-2/ }));
    expect(
      screen.getByRole("button", { name: "重练已选（2 题）" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重练已选（2 题）" }));
    await waitFor(() => {
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-judge-1", "q-judge-2"],
        { workflowVersion: 1 },
        { kind: "selection", questionCount: 2 },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `/s/attempts/${NEW_ATTEMPT_ID}`,
      );
    });
  });

  it("组头「全选本组」勾满该组再点取消全选；跨分区选题计数与提交顺序正确", async () => {
    mockedWrong.mockResolvedValue(selectionData());
    mockedPractice.mockResolvedValue(PRACTICE_SUMMARY);
    renderPageWithAttemptRoute();
    fireEvent.click(await screen.findByRole("button", { name: "选题重练" }));
    // 有理数组两题：全选本组 → 两行勾上、操作条 2 题
    fireEvent.click(screen.getByRole("button", { name: "全选本组（2 题）" }));
    expect(screen.getByText("已选 2 题")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重练已选（2 题）" }),
    ).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /q-judge-1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "取消全选（2 题）" }));
    expect(
      screen.getByRole("button", { name: "重练已选（0 题）" }),
    ).toBeDisabled();

    // 跨分区：待复习选 q-judge-1 → 切已攻克（空）→ 操作条仍计 1；回来再选一题
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-1/ }));
    fireEvent.click(screen.getByRole("button", { name: "已攻克 0 题" }));
    expect(screen.getByText("已选 1 题")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重练已选（1 题）" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "待复习 3 题" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-2/ }));
    expect(screen.getByText("已选 2 题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重练已选（2 题）" }));
    await waitFor(() => {
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-judge-1", "q-judge-2"],
        { workflowVersion: 1 },
        { kind: "selection", questionCount: 2 },
      );
    });
  });

  it("取消退出选题模式并清空选择；Esc 等效退出", async () => {
    mockedWrong.mockResolvedValue(selectionData());
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "选题重练" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-1/ }));
    expect(screen.getByText("已选 1 题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消选题" }));
    // 退出：常规入口回归、复选行消失、无残留操作条
    expect(
      await screen.findByRole("button", { name: "重练全部（3 题）" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("checkbox", { name: /q-judge-1/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/已选 \d+ 题/)).not.toBeInTheDocument();
    // 再入模式：上次选择已清空；Esc 退出
    fireEvent.click(screen.getByRole("button", { name: "选题重练" }));
    expect(
      screen.getByRole("button", { name: "重练已选（0 题）" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "重练全部（3 题）" }),
    ).toBeEnabled();
  });

  it("跨 tab 选题提交顺序（评审修复）：当前 tab 列表序在前，另一 tab 的已选题垫后", async () => {
    // 已攻克题排数组最前（错→对→对，严格标准下攻克）
    const ATTEMPT_C = "88888888-8888-4888-8888-888888888888";
    const conquered = makeQuestion({
      questionId: "q-conquered",
      rounds: [
        round(ATTEMPT_A, false, "2020-09-10T02:00:00.000Z"),
        round(ATTEMPT_B, true, "2020-09-18T02:00:00.000Z"),
        round(ATTEMPT_C, true, "2020-09-25T02:00:00.000Z"),
      ],
      wrongCount: 1,
      correctCount: 2,
      lastAt: "2020-09-25T02:00:00.000Z",
    });
    mockedWrong.mockResolvedValue({
      questions: [conquered, ...selectionData().questions],
    });
    mockedPractice.mockResolvedValue(PRACTICE_SUMMARY);
    renderPageWithAttemptRoute();
    fireEvent.click(await screen.findByRole("button", { name: "选题重练" }));
    // 待复习选 q-judge-1 → 切已攻克选 q-conquered（数组序在前）→ 回待复习
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-1/ }));
    fireEvent.click(screen.getByRole("button", { name: "已攻克 1 题" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /q-conquered/ }));
    fireEvent.click(screen.getByRole("button", { name: "待复习 3 题" }));
    expect(screen.getByText("已选 2 题")).toBeTruthy();
    expect(screen.getByText(/另有 1 题不在当前列表/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重练已选（2 题）" }));
    await waitFor(() => {
      // 当前 tab（待复习）列表序在前：q-judge-1 先于另一 tab 的 q-conquered
      // ——修复前按两 tab 合集数组序提交 [q-conquered, q-judge-1]
      expect(mockedPractice).toHaveBeenCalledWith(
        ["q-judge-1", "q-conquered"],
        { workflowVersion: 1 },
        { kind: "selection", questionCount: 2 },
      );
    });
  });

  it("重练失败后刷新错题本致已选题退出聚合（评审修复）：计数按有效选择归零并禁用，不再静默死端", async () => {
    const data = selectionData();
    mockedWrong.mockResolvedValueOnce(data);
    // 首次组卷网络失败 → 错误横幅提供「刷新错题本」手动 refetch（真实触发路径）
    mockedPractice.mockRejectedValueOnce(new Error("网络异常"));
    renderPageWithAttemptRoute();
    fireEvent.click(await screen.findByRole("button", { name: "选题重练" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /q-judge-1/ }));
    expect(screen.getByText("已选 1 题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重练已选（1 题）" }));
    expect(await screen.findByText("重练组卷失败")).toBeTruthy();
    // 刷新后 q-judge-1 已不在聚合（如公布 gate 变化）：勾选集合保留但有效选择为 0
    mockedWrong.mockResolvedValue({
      questions: data.questions.filter(
        (question) => question.questionId !== "q-judge-1",
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新错题本" }));
    expect(await screen.findByText("已选 0 题")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重练已选（0 题）" }),
    ).toBeDisabled();
  });
});
