import type {
  AttemptActivity,
  AttemptResultQuestion,
  AttemptResultUnit,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render-with-portal";
import { ModuleResultTable } from "./ModuleResultTable";
import { isRetrainable, moduleResultStatsOf } from "./module-result-model";

/** 结果题夹具：客观题，finalCorrect / answered / studentFlag 等判定面可控 */
const questionOf = (
  questionId: string,
  overrides: Partial<{
    finalCorrect: boolean | null;
    answered: boolean;
    studentFlag: "unsure" | null;
    teacherMark: AttemptResultQuestion["teacherMark"];
    gradingPolicy: AttemptResultQuestion["gradingPolicy"];
    selfReview: AttemptResultQuestion["selfReview"];
  }> = {},
): AttemptResultQuestion =>
  ({
    questionId,
    snapshot: {
      id: questionId,
      type: "choice",
      difficulty: 2,
      knowledge: ["资料分析"],
      stemMd: "题干",
      hintCount: 0,
    },
    answers: null,
    solutionMd: null,
    answer: null,
    autoCorrect: null,
    teacherMark: overrides.teacherMark ?? null,
    teacherComment: null,
    finalCorrect: overrides.finalCorrect ?? null,
    answered: overrides.answered ?? true,
    studentFlag: overrides.studentFlag ?? null,
    gradingPolicy: overrides.gradingPolicy ?? "auto",
    selfReview: overrides.selfReview ?? null,
    hintsOpened: [],
  }) as unknown as AttemptResultQuestion;

const UNIT_A: AttemptResultUnit = {
  id: "u-a",
  title: "言语理解",
  timeQuotaMinutes: 30,
  questions: [
    questionOf("a1", { finalCorrect: true }),
    questionOf("a2", { finalCorrect: true, studentFlag: "unsure" }),
    questionOf("a3", { finalCorrect: false }),
    questionOf("a4", { finalCorrect: false, answered: false }), // 跳过且判错：不计答错、不进重练
  ],
};
const UNIT_B: AttemptResultUnit = {
  id: "u-b",
  title: "资料分析",
  questions: [
    // 标了不会但仍待判：服务端错题本只取已判定轮，这里不能先算进重练
    questionOf("b1", { finalCorrect: null, studentFlag: "unsure" }),
    questionOf("b2", { finalCorrect: false }),
  ],
};
/** 整卷有事件、但本模块任何题都没有 byQuestion 条目（#101-01） */
const UNIT_C: AttemptResultUnit = {
  id: "u-c",
  title: "判断推理",
  questions: [
    questionOf("c1", { finalCorrect: true }),
    questionOf("c2", { finalCorrect: true }),
  ],
};
const ACTIVITY: AttemptActivity = {
  version: 1,
  byQuestion: {
    a1: { activeSec: 60, observedSec: 0, actions: 1, viewed: true },
    a2: { activeSec: 30, observedSec: 10, actions: 1, viewed: true },
    b2: { activeSec: 2000, observedSec: 0, actions: 2, viewed: true },
  },
  activeSecTotal: 2090,
  observedSecTotal: 10,
  unattributedSec: 0,
  sessions: 1,
  concurrentSessionsMax: 1,
};

describe("按模块看结果：模型", () => {
  it("已公布：答对 / 作答 / 跳过 / 不确定但对 / 用时 / 配额 / 可重练题", () => {
    const stats = moduleResultStatsOf(UNIT_A, true, ACTIVITY);
    expect(stats).toMatchObject({
      total: 4,
      answered: 3,
      skipped: 1,
      correct: 2,
      wrong: 1,
      pending: 0,
      unsureCorrect: 1,
      activeSec: 90,
      observedSec: 10,
      timeQuotaMinutes: 30,
    });
    // a2 标过不会（即使做对）与 a3 判错进重练；a4 未做不圈入
    expect(stats.wrongQuestionIds).toEqual(["a2", "a3"]);
  });

  it("未公布：对错相关一律 null，只给作答 / 跳过；卷无事件用时 null", () => {
    const stats = moduleResultStatsOf(UNIT_B, false, undefined);
    expect(stats).toMatchObject({
      total: 2,
      answered: 2,
      skipped: 0,
      correct: null,
      wrong: null,
      pending: null,
      unsureCorrect: null,
      activeSec: null,
      timeQuotaMinutes: null,
      wrongQuestionIds: [],
    });
  });

  it("#101-01 整卷有事件但本模块无任何题命中：用时 null（与逐题徽标「无可用记录」同口径），不是 0 秒", () => {
    const stats = moduleResultStatsOf(UNIT_C, true, ACTIVITY);
    expect(stats.activeSec).toBeNull();
    expect(stats.observedSec).toBe(0);
    // 部分题命中仍按命中题求和（b1 无条目、b2 2000s）
    expect(moduleResultStatsOf(UNIT_B, true, ACTIVITY).activeSec).toBe(2000);
  });

  it("#101-02 已公布：标了不会但待判的题不进专项重练（服务端只从已判定轮组卷）", () => {
    const stats = moduleResultStatsOf(UNIT_B, true, ACTIVITY);
    expect(stats).toMatchObject({ wrong: 1, pending: 1, unsureCorrect: 0 });
    expect(stats.wrongQuestionIds).toEqual(["b2"]);
  });
});

describe("isRetrainable：与服务端错题本「已判定轮」谓词同口径（#101-02）", () => {
  const SELF_REVIEW_CORRECT = {
    record: {
      verdict: "correct" as const,
      at: "2026-11-09T10:00:00.000Z",
      revision: 1,
    },
    revision: 1,
  };

  it("标了不会但仍待判（finalCorrect 空且无自评记录）→ 不计", () => {
    expect(isRetrainable(questionOf("q", { studentFlag: "unsure" }))).toBe(
      false,
    );
    // 主观题空提交自动标「不会」、等老师判
    expect(
      isRetrainable(
        questionOf("q", {
          studentFlag: "unsure",
          gradingPolicy: "manual_only",
        }),
      ),
    ).toBe(false);
    // 自评题还没自评（record=null）
    expect(
      isRetrainable(
        questionOf("q", {
          studentFlag: "unsure",
          gradingPolicy: "reference_self",
          selfReview: { record: null, revision: 0 },
        }),
      ),
    ).toBe(false);
  });

  it("标了不会且已判（判对 / 自评对）→ 计", () => {
    expect(
      isRetrainable(
        questionOf("q", { studentFlag: "unsure", finalCorrect: true }),
      ),
    ).toBe(true);
    expect(
      isRetrainable(
        questionOf("q", {
          studentFlag: "unsure",
          gradingPolicy: "reference_self",
          selfReview: SELF_REVIEW_CORRECT,
        }),
      ),
    ).toBe(true);
  });

  it("判错且已作答 → 计；判错未做且无显式判定 → 不计；教师判错的未做题 → 计", () => {
    expect(isRetrainable(questionOf("q", { finalCorrect: false }))).toBe(true);
    expect(
      isRetrainable(questionOf("q", { finalCorrect: false, answered: false })),
    ).toBe(false);
    expect(
      isRetrainable(
        questionOf("q", {
          finalCorrect: false,
          answered: false,
          teacherMark: "wrong",
        }),
      ),
    ).toBe(true);
  });
});

describe("按模块看结果：表格与窄屏卡片", () => {
  it("默认展开，点击标题可收起并再次展开模块结果", () => {
    render(
      <ModuleResultTable
        units={[UNIT_A, UNIT_B]}
        released
        activity={ACTIVITY}
      />,
    );
    const section = screen.getByTestId("module-results");
    const toggle = within(section).getByText("分组统计", { exact: true });
    const disclosure = toggle.closest("details");
    expect(disclosure).toHaveAttribute("open");

    fireEvent.click(toggle);
    expect(disclosure).not.toHaveAttribute("open");

    fireEvent.click(toggle);
    expect(disclosure).toHaveAttribute("open");
    expect(within(section).getByRole("table")).toBeInTheDocument();
    expect(
      within(section).getByTestId("module-results-cards"),
    ).toBeInTheDocument();
  });

  it("多模块：表格每模块一行，点模块名跳到该节；专项重练带模块名；卡片同口径", () => {
    const onStart = vi.fn();
    const scrollIntoView = vi.fn();
    const anchor = document.createElement("h2");
    anchor.setAttribute("data-review-unit", "u-b");
    anchor.scrollIntoView = scrollIntoView;
    document.body.appendChild(anchor);
    render(
      <ModuleResultTable
        units={[UNIT_A, UNIT_B]}
        released
        activity={ACTIVITY}
        wrongPractice={{ loading: false, onStart }}
      />,
    );
    const table = within(screen.getByTestId("module-results")).getByRole(
      "table",
    );
    const rowA = within(table).getByText("言语理解").closest("tr");
    const rowB = within(table).getByText("资料分析").closest("tr");
    expect(rowA?.textContent).toContain("2 / 3 / 4");
    expect(rowA?.textContent).toContain("1 分 30 秒");
    expect(rowA?.textContent).toContain("30 分钟");
    // 资料分析无配额显示「—」；b2 用时 2000s（无配额不比较）
    expect(rowB?.textContent).toContain("—");
    expect(rowB?.textContent).toContain("33 分 20 秒");
    fireEvent.click(within(table).getByRole("button", { name: "资料分析" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(rowA as HTMLElement).getByRole("button", {
        name: /专项重练（2）/,
      }),
    );
    expect(onStart).toHaveBeenCalledWith(["a2", "a3"], "言语理解");
    // 窄屏卡片：同一行口径（jsdom 不解析断点类，两套都在 DOM 里）
    const cards = screen.getByTestId("module-results-cards");
    const cardA = within(cards).getByText("言语理解").closest("li");
    expect(cardA?.textContent).toContain("答对 / 作答 / 题数 2 / 3 / 4");
    expect(cardA?.textContent).toContain("跳过 1 · 不确定但答对 1");
    expect(cardA?.textContent).toContain("用时 1 分 30 秒 · 建议用时 30 分钟");
    anchor.remove();
  });

  it("#101-01 整卷有事件、模块无记录：该行与卡片显示「无可用记录」而不是 0 秒", () => {
    render(
      <ModuleResultTable
        units={[UNIT_A, UNIT_C]}
        released
        activity={ACTIVITY}
      />,
    );
    const section = screen.getByTestId("module-results");
    const rowC = within(within(section).getByRole("table"))
      .getByText("判断推理")
      .closest("tr");
    expect(rowC?.textContent).toContain("无可用记录");
    expect(rowC?.textContent).not.toContain("0 秒");
    const cardC = within(screen.getByTestId("module-results-cards"))
      .getByText("判断推理")
      .closest("li");
    expect(cardC?.textContent).toContain("用时 无可用记录");
  });

  it("单单元无批次默认隐藏，不重复汇总", () => {
    render(
      <ModuleResultTable
        units={[UNIT_B]}
        released={false}
        activity={undefined}
      />,
    );
    expect(screen.queryByTestId("module-results")).toBeNull();
  });
  it("可切换批次、题型、材料、考点，重练跟随当前组", () => {
    const onStart = vi.fn();
    const unit = {
      ...UNIT_A,
      questions: UNIT_A.questions.map((q, index) => ({
        ...q,
        settlementSeq: index < 2 ? 1 : 2,
      })),
    };
    render(
      <ModuleResultTable
        units={[unit]}
        released
        activity={ACTIVITY}
        wrongPractice={{ loading: false, onStart }}
      />,
    );
    fireEvent.change(screen.getByLabelText("分组维度"), {
      target: { value: "settlement" },
    });
    const section = screen.getByTestId("module-results");
    expect(within(section).getAllByText("第 1 批").length).toBe(2);
    fireEvent.click(
      within(section).getAllByRole("button", { name: /专项重练/ })[0]!,
    );
    expect(onStart).toHaveBeenCalledWith(["a2"], "第 1 批");
    for (const dimension of ["type", "material", "knowledge"]) {
      fireEvent.change(screen.getByLabelText("分组维度"), {
        target: { value: dimension },
      });
      expect(within(section).getByRole("table")).toBeInTheDocument();
    }
    expect(section.textContent).not.toMatch(/口径 v1|参考配额/);
  });
});
it("真实分组渲染为完整历史焦点用时加标记，不伪装为活动账", () => {
  const units = [UNIT_A, UNIT_B].map((unit) => ({
    ...unit,
    questions: unit.questions.map((question, index) => ({
      ...question,
      time: {
        metric: "legacy_focus" as const,
        version: null,
        activeSec: index === 0 ? 37 : 0,
      },
    })),
  }));
  render(<ModuleResultTable units={units} released activity={undefined} />);
  const table = within(screen.getByTestId("module-results")).getByRole("table");
  expect(within(table).getAllByText("历史焦点 37 秒")).toHaveLength(2);
});
