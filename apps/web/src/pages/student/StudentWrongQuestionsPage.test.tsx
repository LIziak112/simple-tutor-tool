import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WrongQuestionCard, WrongQuestionsData } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupWrongQuestions,
  parseWrongQuestionsUrl,
  stemSummaryOf,
} from "@/features/student/wrong-questions-ui";
import { fetchStudentWrongQuestionsApi } from "@/lib/api";
import StudentWrongQuestionsPage from "./StudentWrongQuestionsPage";

/**
 * /s/wrong 错题本页组件测试（T3.5，D11；2026-10 轮次史改版）：两 tab
 * （待复习/已攻克，本地攻克标准从 rounds 计算）、分组维度（按练习/按时间/
 * 按考点，URL 同步）、紧凑行 → 展开完整卡片（含轮次史区块）、旧 URL 参数
 * 兼容映射、三态。API 层 mock（页面统一拉全量形态 includeResolved=true）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentWrongQuestionsApi: vi.fn(),
  };
});

const mockedWrong = vi.mocked(fetchStudentWrongQuestionsApi);

const ATTEMPT_A = "66666666-6666-4666-8666-666666666666";
const ATTEMPT_B = "77777777-7777-4777-8777-777777777777";
const ATTEMPT_C = "88888888-8888-4888-8888-888888888888";

/** 轮次工厂 */
function round(
  attemptId: string,
  correct: boolean,
  submittedAt: string,
  sourceTitle = "周末加练",
): WrongQuestionCard["rounds"][number] {
  return {
    attemptId,
    sourceType: "assignment",
    correct,
    submittedAt,
    sourceTitle,
    courseName: "初一上",
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
    // 紧凑行：题干摘要（公式取内文、[[正确]] 渲染为空框）+ 错 N 次
    expect(await screen.findByText("错 2 次")).toBeInTheDocument();
    expect(screen.getByText("错 1 次")).toBeInTheDocument();
    expect(screen.getByText(/1 是正数。/)).toBeInTheDocument();
    // 默认不展开完整卡片（无「我的最近答案」）
    expect(screen.queryByText("我的最近答案：")).not.toBeInTheDocument();
  });

  it("点击紧凑行展开完整卡片：答案/详解折叠/轮次史（统计 + 每轮一行）；再点收起", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();
    const row = await screen.findByRole("button", {
      name: /错 2 次/,
    });
    fireEvent.click(row);
    // 完整卡片：首次标记 + 我的最近答案 + 正确答案
    expect(screen.getByText("首次做错")).toBeInTheDocument();
    expect(screen.getByText("我的最近答案：")).toBeInTheDocument();
    expect(screen.getByText("正确答案：")).toBeInTheDocument();
    // 轮次史区块：汇总 + 每轮一行（第 1/2 轮 · 做错 · 来源标题）
    expect(screen.getByText("已做错 2 次 · 做对 0 次")).toBeInTheDocument();
    expect(screen.getAllByText("第 1 轮").length).toBe(1);
    expect(screen.getAllByText("第 2 轮").length).toBe(1);
    expect(screen.getAllByText("做错").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/周末加练/).length).toBeGreaterThanOrEqual(2);
    // 详解默认折叠
    expect(screen.queryByText(/大于/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /查看详解/ }));
    expect(
      await screen.findByText(/大于/, {}, { timeout: 3000 }),
    ).toBeVisible();
    // 收起
    fireEvent.click(screen.getByRole("button", { name: /错 2 次/ }));
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
    expect(screen.getByText(/0 是负数。/)).toBeInTheDocument();
    // 待复习那两道不在
    expect(screen.queryByText(/1 是正数。/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("计算：(-2)+5=", { exact: false }),
    ).not.toBeInTheDocument();
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
    expect(
      screen.getByText("计算：(-2)+5=", { exact: false }),
    ).toBeInTheDocument();
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

  it("旧 URL 参数兼容：includeResolved=true 映射已攻克 tab；knowledge 忽略不报错", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage("/s/wrong?includeResolved=true&knowledge=有理数的概念");
    expect(
      await screen.findByRole("button", {
        name: "已攻克 1 题",
      }),
    ).toHaveAttribute("aria-pressed", "true");
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

describe("wrong-questions-ui 纯函数", () => {
  it("stemSummaryOf：[[答案]] 替换为空框（不泄露答案原文）、公式取内文、剥 Markdown 记号", () => {
    expect(stemSummaryOf("$1$ 是正数。[[正确]]")).toBe("1 是正数。（　）");
    expect(stemSummaryOf("计算 $\\frac{1}{2}$ 的**相反数**")).toBe(
      "计算 \\frac{1}{2} 的相反数",
    );
  });

  it("parseWrongQuestionsUrl：默认待复习+按练习；tab/group 解析；旧参数映射/忽略", () => {
    expect(parseWrongQuestionsUrl(new URLSearchParams(""))).toEqual({
      tab: "pending",
      group: "unit",
    });
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("tab=conquered&group=time")),
    ).toEqual({ tab: "conquered", group: "time" });
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("includeResolved=true")),
    ).toEqual({ tab: "conquered", group: "unit" });
    expect(
      parseWrongQuestionsUrl(new URLSearchParams("tab=what&group=nope")),
    ).toEqual({ tab: "pending", group: "unit" });
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
