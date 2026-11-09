import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AttemptActivity,
  AttemptResultQuestion,
  AttemptResultUnit,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { ModuleResultTable } from "./ModuleResultTable";
import { moduleResultStatsOf } from "./module-result-model";

/** 结果题夹具：客观题，finalCorrect / answered / studentFlag 可控 */
const questionOf = (
  questionId: string,
  overrides: Partial<{
    finalCorrect: boolean | null;
    answered: boolean;
    studentFlag: "unsure" | null;
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
    teacherMark: null,
    teacherComment: null,
    finalCorrect: overrides.finalCorrect ?? null,
    answered: overrides.answered ?? true,
    studentFlag: overrides.studentFlag ?? null,
    gradingPolicy: "auto",
    selfReview: null,
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
    questionOf("b1", { finalCorrect: null }),
    questionOf("b2", { finalCorrect: false }),
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
});

describe("按模块看结果：表格与窄屏卡片", () => {
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
    expect(cardA?.textContent).toContain(
      "活动用时 1 分 30 秒 · 参考配额 30 分钟",
    );
    anchor.remove();
  });

  it("未公布：无答对列与重练按钮，模块名不是按钮（单模块）", () => {
    render(
      <ModuleResultTable
        units={[UNIT_B]}
        released={false}
        activity={undefined}
        wrongPractice={{ loading: false, onStart: vi.fn() }}
      />,
    );
    const section = screen.getByTestId("module-results");
    expect(within(section).queryByText("不确定但答对")).toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(
      within(within(section).getByRole("table"))
        .getByText("资料分析")
        .closest("tr")?.textContent,
    ).toContain("无可用记录");
  });
});
