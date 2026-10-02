import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WrongQuestionCard, WrongQuestionsData } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentWrongQuestionsApi } from "@/lib/api";
import StudentWrongQuestionsPage from "./StudentWrongQuestionsPage";

/**
 * /s/wrong 错题本页组件测试（T3.5，D11；2026-10 升为一级路由）：考点 chips
 * （全量形态聚合）与「显示已攻克」开关的 URL 同步、条目卡片内容（首次做对
 * 标记/我的答案/正确答案/详解折叠/已攻克徽章）、三态。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentWrongQuestionsApi: vi.fn(),
  };
});

const mockedWrong = vi.mocked(fetchStudentWrongQuestionsApi);

/** 条目工厂（judge 题默认；overrides 换考点/攻克状态/题型） */
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
    firstAt: "2026-09-20T02:00:00.000Z",
    lastAt: "2026-09-28T02:00:00.000Z",
    ...overrides,
  };
}

const STILL_WRONG = makeQuestion();
const RESOLVED_ONE = makeQuestion({
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
});

/** 全量形态（chips 数据源）：含已攻克 */
const ALL_DATA: WrongQuestionsData = {
  questions: [STILL_WRONG, RESOLVED_ONE],
};

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
});

describe("StudentWrongQuestionsPage 筛选（URL 同步）", () => {
  it("考点 chips 从全量形态聚合（含已攻克的考点）；点 chip 写 URL 并带 knowledge 请求", async () => {
    // 主列表（默认形态）与全量形态共用 mock 实现：按 includeResolved 分流
    mockedWrong.mockImplementation(async (params) =>
      params.includeResolved ? ALL_DATA : { questions: [STILL_WRONG] },
    );
    renderPage();
    // chips：全部考点 + 两个考点（来自含已攻克的全量数据）
    expect(
      await screen.findByRole("button", { name: "有理数加法" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "有理数的概念" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "全部考点" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "有理数加法" }));
    // URL 里中文经 encodeURIComponent 编码（断言用编码后的串）
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `knowledge=${encodeURIComponent("有理数加法")}`,
      ),
    );
    // 主列表请求带上考点参数（encodeURIComponent 由浏览器处理）
    await waitFor(() =>
      expect(mockedWrong).toHaveBeenCalledWith(
        expect.objectContaining({ knowledge: "有理数加法" }),
      ),
    );
  });

  it("「显示已攻克」开关写 URL（includeResolved=true）并请求开关形态", async () => {
    mockedWrong.mockImplementation(async (params) =>
      params.includeResolved ? ALL_DATA : { questions: [STILL_WRONG] },
    );
    renderPage();

    // 默认只列最近仍错（1 条；已攻克条不在）
    expect(await screen.findByText("错题本")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("已攻克")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "显示已攻克" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "includeResolved=true",
      ),
    );
    // 开关形态下列出已攻克条目（带徽章）
    await waitFor(() => expect(screen.getByText("已攻克")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "显示已攻克" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("StudentWrongQuestionsPage 条目卡片（D11）", () => {
  it("题干渲染、我的最近答案、正确答案、详解默认折叠点开可见、首次标记与来源", async () => {
    mockedWrong.mockResolvedValue(ALL_DATA);
    renderPage();

    // 首次做错标记（两条都在；卡片含多个 RichMarkdown，放宽等待上限）
    const marks = await screen.findAllByText("首次做错", {}, { timeout: 5000 });
    expect(marks.length).toBe(2);
    // 我的最近答案 / 正确答案（judge：对）
    expect(screen.getAllByText("我的最近答案：").length).toBe(2);
    expect(screen.getAllByText("正确答案：").length).toBe(2);
    expect(screen.getAllByText("对", { exact: true }).length).toBe(1);
    // 详解默认收起：解文字不可见（「大于」只出现在 judge 题详解里； getNodeText
    // 取元素直接文本节点，题干/公式的文本不会误命中），点开后可见
    expect(screen.queryByText(/大于/)).toBeNull();
    const folds = screen.getAllByRole("button", { name: /查看详解/ });
    expect(folds.length).toBe(2);
    fireEvent.click(folds[0] as HTMLElement);
    expect(
      await screen.findByText(/大于/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // 来源行：作业标题（课程名）
    expect(screen.getAllByText(/周末加练（初一上）/).length).toBe(2);
  });

  it("未作为 null 显示「未作答」；无标准答案显示「由老师批改后公布」；选项题正确项标记", async () => {
    mockedWrong.mockResolvedValue({
      questions: [
        makeQuestion({
          questionId: "q-choice-3",
          type: "choice",
          difficulty: 2,
          knowledge: ["相反数"],
          stemMd: "$-5$ 的相反数是（　）",
          options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
          answers: { kind: "choice", index: 1 },
          answerText: null,
        }),
      ],
    });
    renderPage();
    await screen.findByText("首次做错", {}, { timeout: 5000 });
    expect(screen.getByText("未作答")).toBeInTheDocument();
    expect(screen.getByText("正确项")).toBeInTheDocument();
    // 字母 B：选项行与「正确答案」文本都会出现
    expect(screen.getAllByText("B").length).toBeGreaterThanOrEqual(1);
  });

  it("填空正确答案为裸 LaTeX 时按 KaTeX 渲染（显示侧自动包 $，与结果视图同一管线）", async () => {
    mockedWrong.mockResolvedValue({
      questions: [
        makeQuestion({
          questionId: "q-fill-latex",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算（　）。",
          answers: { kind: "fill", blanks: [["-\\frac{5}{4}", "-5/4"]] },
          answerText: "-5/4",
        }),
      ],
    });
    renderPage();
    await screen.findByText("首次做错", {}, { timeout: 5000 });
    // 正确答案行：裸 LaTeX 等价答案自动包 $ 渲染出 KaTeX 节点，普通写法保留文本
    const label = screen.getAllByText("正确答案：")[0];
    const row = label?.parentElement;
    expect(row?.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/或 -5\/4/)).toBeInTheDocument();
    expect(screen.queryByText(/-\\frac\{5\}\{4\} 或 -5\/4/)).toBeNull();
  });
});

describe("StudentWrongQuestionsPage 三态", () => {
  it("加载中显示骨架；空列表按场景给出指引", async () => {
    mockedWrong.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载错题本…")).toBeInTheDocument();
  });

  it("默认空：还没有需要复习的错题；考点筛选空：当前考点下没有错题", async () => {
    mockedWrong.mockResolvedValue({ questions: [] });
    renderPage();
    expect(await screen.findByText("还没有需要复习的错题")).toBeInTheDocument();

    mockedWrong.mockClear();
    renderPage("/s/wrong?knowledge=不存在的考点");
    expect(await screen.findByText("当前考点下没有错题")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试", async () => {
    mockedWrong.mockRejectedValue(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("错题本加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
