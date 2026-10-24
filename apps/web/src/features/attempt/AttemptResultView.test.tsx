import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderReact,
  screen,
  within,
} from "@testing-library/react";
import type { AttemptResultData } from "@tutor/contract";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { reviewPackStubDatasets } from "@/features/export/review-pack-test-stub";
import { correctionStubDatasets } from "@/features/notes/correction-test-stub";
import { noteOriginalStubDatasets } from "@/features/notes/note-original-test-stub";
import { fetchAttemptContextApi } from "@/lib/api";
import { AttemptResultView } from "./AttemptResultView";

// SAI-22 起结果视图接 AI 复盘装配（查询客户端必需）；每次渲染独立 client，
// wrapper 形态保证 rerender 保有 Provider 与缓存
function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return renderReact(ui, { wrapper: Wrapper });
}

/**
 * 结果视图组件测试（T2.6）：得分汇总（scoreAuto/对错待批/未答说明）、
 * 逐题 ✓/✗/待批图标、本人答案 vs 参考答案、详解默认折叠、返回首页。
 */

// T6R.11：原稿查看面板以桩替换（面板自身行为见 NoteOriginalView.test），
// 这里只断言接线——哪些题渲染入口、角色/attempt/题目/轮次标注怎么传
vi.mock("@/features/notes/NoteOriginalView", async () => {
  const { NoteOriginalTestStub } = await import(
    "@/features/notes/note-original-test-stub"
  );
  return { NoteOriginalView: NoteOriginalTestStub };
});

// T6R.15：订正区以桩替换（行为见 CorrectionSection.test）——所有题型都
// 渲染订正入口（手写题没有草稿层也有订正）；只断言接线定位
vi.mock("@/features/notes/CorrectionSection", async () => {
  const { CorrectionTestStub } = await import(
    "@/features/notes/correction-test-stub"
  );
  return { CorrectionSection: CorrectionTestStub };
});

// T6R.13：单题完整导出面板以桩替换（面板行为见 review-pack-panel.test），
// 这里只断言接线——每题一个入口、学生角色、attempt/题目/题号定位
vi.mock("@/features/export/review-pack-panel", async () => {
  const { ReviewPackTestStub } = await import(
    "@/features/export/review-pack-test-stub"
  );
  return { ReviewPackPanel: ReviewPackTestStub };
});

// QM-08：只读题面消费 /attempts/:id/context 冻结投影（组段数据解释）——
// 缺省空投影（legacy 卷）；组段用例在测试内覆写返回值
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAttemptContextApi: vi.fn(async (attemptId: string) => ({
      attemptId,
      materials: [],
      groups: [],
    })),
  };
});

const DATA: AttemptResultData = {
  attempt: {
    id: "55555555-5555-4555-8555-555555555555",
    sourceType: "assignment",
    assignmentId: "44444444-4444-4444-8444-444444444444",
    lectureId: null,
    courseId: null,
    // T2A.7：assignment 来源多单元化后 unitId 为 null
    unitId: null,
    attemptNo: 1,
    status: "submitted",
    startedAt: "2026-09-27T02:00:00.000Z",
    submittedAt: "2026-09-27T02:30:00.000Z",
    scoreAuto: 60,
  },
  title: "周末加练",
  courseName: null,
  dueAt: null,
  answersReleased: true,
  enabledCapabilities: ["steps", "ink"],
  summary: {
    total: 4,
    answered: 3,
    correct: 1,
    wrong: 2,
    pending: 1,
    unanswered: 1,
    autoGradable: 3,
    // D9（T3.5）：仍有待批 → scoreFinal null、pendingCount 1
    scoreFinal: null,
    pendingCount: 1,
  },
  // T2A.7：逐题结果按单元分组（单单元不渲染节标题）
  units: [
    {
      id: "练习四",
      title: "练习四",
      questions: [
        {
          questionId: "练习四-1",
          snapshot: {
            id: "练习四-1",
            type: "judge",
            difficulty: 1,
            knowledge: ["有理数的概念"],
            stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
            hintCount: 0,
          },
          answers: { kind: "judge", value: true },
          solutionMd: "$0$ 是正数与负数的分界点。",
          answer: { kind: "judge", value: true },
          autoCorrect: true,
          // D9：未批注 → null，finalCorrect 随 autoCorrect
          teacherMark: null,
          teacherComment: null,
          finalCorrect: true,
          hintsOpened: [],
        },
        {
          questionId: "练习四-2",
          snapshot: {
            id: "练习四-2",
            type: "choice",
            difficulty: 1,
            knowledge: ["相反数"],
            stemMd: "$-5$ 的相反数是（　）",
            options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
            hintCount: 1,
          },
          answers: { kind: "choice", index: 1 },
          solutionMd: "故选 B。",
          answer: { kind: "choice", index: 0 },
          autoCorrect: false,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: false,
          // T2.11：做题时解锁过第 0 条提示 → 结果视图回看
          hintsOpened: [{ index: 0, text: "只有符号不同的两个数互为相反数。" }],
        },
        {
          questionId: "练习四-4",
          snapshot: {
            id: "练习四-4",
            type: "fill",
            difficulty: 2,
            knowledge: ["有理数的大小比较"],
            stemMd: "写出相反数：$-\\frac{1}{2}$ 的相反数是（　）。",
            hintCount: 0,
          },
          // T2.13 后规范约定：填空答案需公式展示时写 $…$（判分自动剥 $）
          answers: {
            kind: "fill",
            blanks: [["$\\frac{1}{2}$", "1/2"], ["8"]],
          },
          solutionMd: null,
          answer: { kind: "fill", values: ["1/2", ""] },
          autoCorrect: false,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: false,
          hintsOpened: [],
        },
        {
          questionId: "p4-q7",
          snapshot: {
            id: "p4-q7",
            type: "solve",
            difficulty: 3,
            knowledge: ["有理数混合运算"],
            stemMd: "计算，写出过程。",
            hintCount: 0,
          },
          answers: null,
          solutionMd: null,
          answer: null,
          autoCorrect: null,
          // D9：手写题未批 → 批注与最终判定全 null（待批）
          teacherMark: null,
          teacherComment: null,
          finalCorrect: null,
          hintsOpened: [],
        },
      ],
    },
  ],
};

function renderView(onBackHome = vi.fn()) {
  return render(<AttemptResultView data={DATA} onBackHome={onBackHome} />);
}

describe("得分汇总卡", () => {
  it("答案由待公布变为公布时，材料控制器保持挂载", () => {
    const ui = (released: boolean) => (
      <AttemptResultView
        data={{ ...DATA, answersReleased: released }}
        onBackHome={() => {}}
      />
    );
    const { rerender } = render(ui(false));
    const card = screen.getByRole("article", { name: "第 1 题" });
    const original = within(card).getByTestId("note-original-stub");
    rerender(ui(true));
    expect(within(card).getByTestId("note-original-stub")).toBe(original);
  });
  it("先读答案与详解，再访问原稿和订正，定位范围不卸载正文", () => {
    renderView();
    const card = screen.getByRole("article", { name: "第 1 题" });
    const answer = within(card).getByText("你的答案：");
    const solution = within(card).getByRole("button", { name: "查看详解" });
    const tools = within(card).getByRole("region", {
      name: "第 1 题材料与订正",
    });
    expect(
      answer.compareDocumentPosition(solution) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(tools).toContainElement(solution);
    fireEvent.change(screen.getByRole("combobox", { name: "回看定位范围" }), {
      target: { value: "wrong" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(within(card).getByTestId("note-original-stub")).toBeInTheDocument();
  });
  it("显示得分、对/错/待批与未答计数（D1：未答独立展示）与交卷时间", () => {
    renderView();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/自动判分得分/)).toBeInTheDocument();
    const statistics = screen.getByLabelText("题目数量统计");
    expect(statistics).toHaveTextContent("总题数4题");
    expect(statistics).toHaveTextContent("答对1题");
    expect(statistics).toHaveTextContent("答错2题");
    expect(statistics).toHaveTextContent("待批1题");
    expect(statistics).toHaveTextContent("未答1题");
    expect(screen.getByText(/交卷时间：/)).toBeInTheDocument();
  });

  it("全待批且未答时不声称未答题已判错，未答数独立说明", () => {
    render(
      <AttemptResultView
        data={{
          ...DATA,
          attempt: { ...DATA.attempt, scoreAuto: null },
          summary: {
            ...DATA.summary,
            answered: 0,
            correct: 0,
            wrong: 0,
            pending: 4,
            pendingCount: 4,
            unanswered: 4,
            autoGradable: 0,
          },
          units: DATA.units.map((unit) => ({
            ...unit,
            questions: unit.questions.map((question) => ({
              ...question,
              answer: null,
              autoCorrect: null,
              finalCorrect: null,
            })),
          })),
        }}
        onBackHome={() => {}}
      />,
    );
    expect(
      screen.getByText("未答数单独统计，可能与判错或待批重叠，不能相加。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已计入判错/)).toBeNull();
  });

  it("返回首页按钮触发回调", () => {
    const onBackHome = vi.fn();
    renderView(onBackHome);
    fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
    expect(onBackHome).toHaveBeenCalledTimes(1);
  });

  it("多单元作业渲染节标题（单元标题）且题号全卷连续；单单元不渲染节头", () => {
    // 把第 4 题拆到第二个单元 → 两组；题号累计（第 4 题仍显示「第 4 题」）
    const [firstUnit, ...rest] = DATA.units;
    const secondUnit = {
      id: "练习五",
      title: "练习五",
      questions: (firstUnit?.questions ?? []).slice(3),
    };
    const multi: AttemptResultData = {
      ...DATA,
      units: [
        {
          id: firstUnit?.id ?? "",
          title: firstUnit?.title ?? "",
          questions: (firstUnit?.questions ?? []).slice(0, 3),
        },
        ...(rest.length > 0 || secondUnit.questions.length === 0
          ? []
          : [secondUnit]),
      ],
    };
    const view = render(
      <AttemptResultView data={multi} onBackHome={vi.fn()} />,
    );
    expect(screen.getByText("练习四")).toBeInTheDocument();
    expect(screen.getByText("练习五")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "练习五", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText("第 4 题")).toBeInTheDocument();
    view.unmount();

    // 对照：单单元（DATA 本体）不渲染节标题
    renderView();
    expect(screen.queryByRole("heading", { name: "练习四" })).toBeNull();
  });
});

describe("逐题结果卡", () => {
  it("✓/✗/待批 图标与题头元信息（题号/题型/难度/考点）", () => {
    renderView();
    expect(screen.getAllByLabelText("答对").length).toBe(1);
    expect(screen.getAllByLabelText("答错").length).toBe(2);
    expect(screen.getAllByLabelText("待批改").length).toBe(1);
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getAllByText("判断").length).toBeGreaterThan(0);
    expect(screen.getAllByText("相反数").length).toBeGreaterThan(0);
  });

  it("本人答案 vs 参考答案；无标准答案显示「暂无参考答案」", () => {
    renderView();
    expect(screen.getAllByText("你的答案：").length).toBe(4);
    // 答错的单选：你的答案 A / 参考答案 B（选项字母行也会出现 A/B，取全部）
    expect(screen.getAllByText("A").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("B").length).toBeGreaterThanOrEqual(2);
    // 未作答的手写题
    expect(screen.getByRole("article", { name: "第 4 题" })).toHaveTextContent(
      "未作答",
    );
    expect(screen.getByText("暂无参考答案")).toBeInTheDocument();
  });

  it("参考答案含 $…$ 公式时按 KaTeX 渲染（不再显示 $ 原文）", () => {
    renderView();
    const labels = screen.getAllByText("参考答案：");
    expect(labels.length).toBe(4);
    // 填空题（第 3 题）的参考答案行：拼接结果 $\frac{1}{2}$ 或 1/2；8 应渲染出公式
    const fillRow = labels[2]?.parentElement;
    expect(fillRow).toBeTruthy();
    expect(fillRow?.querySelectorAll(".katex").length).toBeGreaterThan(0);
    // 未渲染时的纯文本串（带 $ 定界与 LaTeX 命令）不应作为文本节点出现
    expect(screen.queryByText("$\\frac{1}{2}$ 或 1/2；8")).toBeNull();
    // 普通写法答案与分隔词不受影响
    expect(screen.getByText(/或 1\/2/)).toBeInTheDocument();
  });

  it("参考答案为裸 LaTeX（标记内禁 $ 后的新写法）时显示侧自动包 $ 渲染；final 答案同理", () => {
    // fill 第 3 题换新写法（无 $ 的裸 LaTeX 等价答案）；solve 第 4 题补 final 参考答案
    const data: AttemptResultData = {
      ...DATA,
      units: DATA.units.map((unit) => ({
        ...unit,
        questions: unit.questions.map((question) => {
          if (question.questionId === "练习四-4") {
            return {
              ...question,
              answers: {
                kind: "fill" as const,
                blanks: [["-\\frac{5}{4}", "-5/4"], ["\\sqrt{2}"]],
              },
            };
          }
          if (question.questionId === "p4-q7") {
            return {
              ...question,
              answers: { kind: "final" as const, answer: "x=\\pm 1" },
            };
          }
          return question;
        }),
      })),
    };
    render(<AttemptResultView data={data} onBackHome={vi.fn()} />);
    const labels = screen.getAllByText("参考答案：");
    expect(labels.length).toBe(4);
    // fill 行（第 3 题）：裸 LaTeX 等价答案自动包 $，两个公式渲染为 KaTeX 节点；
    // 普通写法 -5/4 作为文本保留
    const fillRow = labels[2]?.parentElement;
    expect(fillRow?.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByText(/或 -5\/4/)).toBeInTheDocument();
    // final 行（第 4 题）：x=\pm 1 同样走公式管线
    const finalRow = labels[3]?.parentElement;
    expect(finalRow?.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
      1,
    );
    // 裸 LaTeX 源码串不作为纯文本出现
    expect(screen.queryByText(/-\\frac\{5\}\{4\} 或 -5\/4/)).toBeNull();
  });

  it("手写原稿按需读取PNG，客观题不拉手写图片", () => {
    renderView();
    expect(
      screen.queryByAltText("第 p4-q7 题的手写笔迹"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("article", { name: "第 4 题" })).getByRole(
        "button",
        { name: "本次原稿" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看手写原稿" }));
    const img = screen.getByAltText("第 p4-q7 题的手写笔迹");
    expect(img).toHaveAttribute(
      "src",
      "/api/student/attempts/55555555-5555-4555-8555-555555555555/ink/p4-q7.png",
    );
    // 判断题（第 1 题）无笔迹区块
    expect(document.querySelectorAll('img[alt$="题的手写笔迹"]').length).toBe(
      1,
    );
    expect(screen.getByText("我的手写笔迹")).toBeInTheDocument();
  });

  it("选项正确项/你的选择有标记", () => {
    renderView();
    expect(screen.getByText("正确项")).toBeInTheDocument();
    expect(screen.getByText("你的选择")).toBeInTheDocument();
  });

  it("详解默认收起，点开显示内容；无详解显示提示文案", () => {
    renderView();
    const folds = screen.getAllByRole("button", { name: /查看详解/ });
    expect(folds.length).toBe(2); // 填空与手写题无详解（显示文案而非折叠钮）
    // 详解内容含 KaTeX 公式节点，用不含公式的子串断言
    expect(screen.queryByText(/是正数与负数的分界点/)).toBeNull();
    fireEvent.click(folds[0] as HTMLElement);
    expect(screen.getByText(/是正数与负数的分界点/)).toBeInTheDocument();
    expect(screen.getAllByText("这道题没有详解。").length).toBe(2);
  });

  it("T2.11 回看：解锁过的题显示「做题时看过的提示」与条目内容；没解锁过的题不显示该区块", () => {
    renderView();
    expect(screen.getByText("做题时看过的提示（1 条）")).toBeInTheDocument();
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(
      screen.getByText(/只有符号不同的两个数互为相反数/),
    ).toBeInTheDocument();
    // 只有一道题解锁过提示 → 区块标题只出现一次
    expect(screen.getAllByText(/做题时看过的提示/).length).toBe(1);
  });
});

describe("T2A.8 未公布形态（answersReleased=false，截止后公布且未到截止）", () => {
  /** 基础单元（DATA 单元；noUncheckedIndexedAccess 下先收窄再展开） */
  const baseUnit = DATA.units[0];
  /** 受限形态的逐题：answers/solutionMd/autoCorrect 全 null、题干公开化 */
  const restrictedQuestions = (baseUnit?.questions ?? []).map((question) => ({
    ...question,
    snapshot: {
      ...question.snapshot,
      // 公开化版题干（[[答案]] 标记替换为 [[]]）
      stemMd: question.snapshot.stemMd.replace(/\[\[[^[\]]*\]\]/g, "[[]]"),
    },
    answers: null,
    solutionMd: null,
    autoCorrect: null,
    // D9：未公布口径下批注与最终判定同样置 null 投影
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
  }));
  /** 受限形态：服务端口径——逐题受限 + scoreAuto 置 null 投影 +
   * summary 对错零化（pending=answered 口径；scoreFinal/pendingCount 置 null） */
  const RESTRICTED: AttemptResultData = {
    ...DATA,
    answersReleased: false,
    dueAt: "2026-10-01T12:00:00.000Z",
    attempt: { ...DATA.attempt, scoreAuto: null },
    summary: {
      total: 4,
      answered: 3,
      correct: 0,
      wrong: 0,
      pending: 3,
      unanswered: 1,
      autoGradable: 0,
      scoreFinal: null,
      pendingCount: null,
    },
    units:
      baseUnit === undefined
        ? []
        : [{ ...baseUnit, questions: restrictedQuestions }],
  };

  it("汇总卡替换为「PendingReleaseBanner」横幅：无得分数字、无对错计数、含截止时间与已答统计", () => {
    render(<AttemptResultView data={RESTRICTED} onBackHome={vi.fn()} />);
    expect(screen.getByText("🎉 作业已成功交卷！")).toBeInTheDocument();
    expect(screen.getByText(/截止时间：/)).toBeInTheDocument();
    expect(screen.queryByText(/自动判分得分/)).toBeNull();
    expect(screen.queryByText("60")).toBeNull();
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("答对");
    expect(bodyText).not.toContain("答错");
    expect(bodyText).not.toContain("待批");
    expect(bodyText).toContain("3 / 4 题");
    expect(
      screen.getByRole("heading", { name: "周末加练", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "已交卷", level: 2 }),
    ).toBeInTheDocument();
  });

  it("逐题卡只渲染本人作答内容：无对错图标、无详解、参考答案显示待公布提示；题头展示保存状态；本人答案与已解锁提示保留", () => {
    render(<AttemptResultView data={RESTRICTED} onBackHome={vi.fn()} />);
    expect(screen.queryAllByLabelText("答对").length).toBe(0);
    expect(screen.queryAllByLabelText("答错").length).toBe(0);
    expect(screen.queryAllByLabelText("待批改").length).toBe(0);
    expect(screen.getAllByText("答案已保存 · 待公布").length).toBe(3);
    expect(screen.getAllByText("未作答").length).toBeGreaterThan(0);
    expect(screen.getAllByText("参考答案与详解将在截止后公布 🔒").length).toBe(
      4,
    );
    expect(screen.queryAllByRole("button", { name: /查看详解/ }).length).toBe(
      0,
    );
    // 详解文本（收起时也不渲染）与答案标记题干不出现
    expect(screen.queryByText(/是正数与负数的分界点/)).toBeNull();
    expect(screen.queryByText(/\[\[正确\]\]/)).toBeNull();
    // 本人答案与做题时看过的提示照常
    expect(screen.getAllByText("你的答案：").length).toBe(4);
    expect(screen.getByText(/做题时看过的提示（1 条）/)).toBeInTheDocument();
  });

  it("未公布的选项只显示中性本人选择，不暗示判错", () => {
    render(<AttemptResultView data={RESTRICTED} onBackHome={vi.fn()} />);
    const picked = screen.getByText("你的选择").closest("li");
    expect(picked?.className).not.toMatch(/red|emerald/);
    expect(screen.queryByText("正确项")).toBeNull();
  });

  it("对照：answersReleased=true（默认公布）完整渲染（回归保障）", () => {
    renderView();
    expect(screen.queryByText(/已交卷，答案将在截止后公布/)).toBeNull();
    expect(screen.getAllByLabelText("答对").length).toBe(1);
    expect(screen.getAllByText("参考答案：").length).toBe(4);
    expect(screen.getAllByRole("button", { name: /查看详解/ }).length).toBe(2);
  });
});

describe("D9（T3.5）老师批改后的展示", () => {
  /**
   * 批改后形态：手写题（第 4 题）批对 + 评语；判断题（第 1 题）被改判为错
   * （finalCorrect 以 teacherMark 为准）；attempt 整卷 graded、scoreFinal=50、
   * pendingCount=0。答对/答错计数仍是 autoCorrect 口径（契约字段如此）。
   */
  const baseUnit = DATA.units[0];
  const GRADED: AttemptResultData = {
    ...DATA,
    attempt: { ...DATA.attempt, status: "graded", scoreAuto: 60 },
    summary: {
      ...DATA.summary,
      correct: 1,
      wrong: 2,
      pending: 1,
      scoreFinal: 50,
      pendingCount: 0,
    },
    units:
      baseUnit === undefined
        ? []
        : [
            {
              ...baseUnit,
              questions: baseUnit.questions.map((question) => {
                if (question.questionId === "p4-q7") {
                  return {
                    ...question,
                    teacherMark: "correct" as const,
                    teacherComment: "过程清晰，答案正确。",
                    finalCorrect: true,
                  };
                }
                if (question.questionId === "练习四-1") {
                  return {
                    ...question,
                    teacherMark: "wrong" as const,
                    teacherComment: null,
                    finalCorrect: false,
                  };
                }
                return question;
              }),
            },
          ],
  };

  it("汇总大数字显示最终得分 scoreFinal（标签「含老师批改」），待批计数用 pendingCount 归零", () => {
    render(<AttemptResultView data={GRADED} onBackHome={vi.fn()} />);
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("最终得分", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("含老师批改，满分 100")).toBeInTheDocument();
    // 回归：不再显示旧口径的自动判分标签
    expect(screen.queryByText(/自动判分得分/)).toBeNull();
    // pendingCount=0（summary.pending 仍为 1，展示以权威计数为准；
    // 数字与标签组成独立统计项，采用服务端权威计数。
    const statistics = screen.getByLabelText("题目数量统计");
    expect(statistics).toHaveTextContent("待批0题");
    expect(statistics).not.toHaveTextContent("待批1题");
  });

  it("批过的题显著展示「老师批改：判对/判错」与评语", () => {
    render(<AttemptResultView data={GRADED} onBackHome={vi.fn()} />);
    // 块标题行内文字被 JSX 拆分（老师批改：+ 判对/判错），用整体文本断言
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("老师批改：判对");
    expect(bodyText).toContain("老师批改：判错");
    expect(screen.getByText("过程清晰，答案正确。")).toBeInTheDocument();
  });

  it("最终判定以批注为准：自动判对后被改判的题显示「答错」", () => {
    render(<AttemptResultView data={GRADED} onBackHome={vi.fn()} />);
    // 第 1 题 autoCorrect=true 但 finalCorrect=false（teacherMark=wrong）
    expect(screen.getAllByLabelText("答错").length).toBe(3);
    expect(screen.getAllByLabelText("答对").length).toBe(1);
    expect(screen.queryAllByLabelText("待批改").length).toBe(0);
  });

  it("未批且已交（teacherMark/Comment 为 null）维持既有待批态，不渲染老师批改块", () => {
    renderView();
    // 老师批改块与参考答案缺省文案分开断言。
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("老师批改：");
    expect(screen.getAllByLabelText("待批改").length).toBe(1);
  });
});

// ---------- 2026-10：练习本卷错题（结果页直达重练入口） ----------

describe("练习本卷错题按钮（2026-10 直达重练）", () => {
  /** 通用入口 props（个别用例按需覆盖 loading/error/onStart） */
  const practiceProps = () => ({
    loading: false,
    error: null,
    onStart: vi.fn(),
  });

  it("已公布且有判错题：示数 N = finalCorrect=false 题数（不含答对与待批）；点击回传按本卷题序的 questionIds", () => {
    const onStart = vi.fn();
    render(
      <AttemptResultView
        data={DATA}
        onBackHome={vi.fn()}
        wrongPractice={{ loading: false, error: null, onStart }}
      />,
    );
    // DATA 四题：对 / 错 / 错 / 待批 → N=2（待批 finalCorrect=null 不计）
    fireEvent.click(
      screen.getByRole("button", { name: "练习本卷错题（2 题）" }),
    );
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(["练习四-2", "练习四-4"]);
  });

  it("教师改判后计数跟随 finalCorrect（GRADED：改判错 + 自动错两题 → 3 题）", () => {
    const baseUnit = DATA.units[0];
    const GRADED: AttemptResultData = {
      ...DATA,
      attempt: { ...DATA.attempt, status: "graded" },
      units:
        baseUnit === undefined
          ? []
          : [
              {
                ...baseUnit,
                questions: baseUnit.questions.map((question) =>
                  question.questionId === "练习四-1"
                    ? {
                        ...question,
                        teacherMark: "wrong" as const,
                        finalCorrect: false,
                      }
                    : question.questionId === "p4-q7"
                      ? {
                          ...question,
                          teacherMark: "correct" as const,
                          finalCorrect: true,
                        }
                      : question,
                ),
              },
            ],
    };
    render(
      <AttemptResultView
        data={GRADED}
        onBackHome={vi.fn()}
        wrongPractice={practiceProps()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "练习本卷错题（3 题）" }),
    ).toBeInTheDocument();
  });

  it("提交中：按钮禁用并显示「正在组卷…」", () => {
    render(
      <AttemptResultView
        data={DATA}
        onBackHome={vi.fn()}
        wrongPractice={{ loading: true, error: null, onStart: vi.fn() }}
      />,
    );
    const button = screen.getByRole("button", { name: "正在组卷…" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: /练习本卷错题/ })).toBeNull();
  });

  it("失败：error 非 null 时按钮下方显示中文告警（role=alert）", () => {
    render(
      <AttemptResultView
        data={DATA}
        onBackHome={vi.fn()}
        wrongPractice={{
          loading: false,
          error: "没有可重练的题目",
          onStart: vi.fn(),
        }}
      />,
    );
    // role=alert 按 ARIA 不能从内容取名（name 查询恒空），断言用文本内容
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("练习本卷错题组卷失败：没有可重练的题目");
  });

  it("未公布（answersReleased=false）隐藏——公布 gate 双保险", () => {
    const unreleased: AttemptResultData = { ...DATA, answersReleased: false };
    render(
      <AttemptResultView
        data={unreleased}
        onBackHome={vi.fn()}
        wrongPractice={practiceProps()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /练习本卷错题|正在组卷/ }),
    ).toBeNull();
  });

  it("全对/只剩待批（N=0）隐藏", () => {
    const baseUnit = DATA.units[0];
    const allRight: AttemptResultData = {
      ...DATA,
      units:
        baseUnit === undefined
          ? []
          : [
              {
                ...baseUnit,
                questions: baseUnit.questions.map((question) =>
                  // 两道自动判错题改为判对；手写题保持待批 null
                  question.finalCorrect === false
                    ? { ...question, finalCorrect: true, autoCorrect: true }
                    : question,
                ),
              },
            ],
    };
    render(
      <AttemptResultView
        data={allRight}
        onBackHome={vi.fn()}
        wrongPractice={practiceProps()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /练习本卷错题|正在组卷/ }),
    ).toBeNull();
  });

  it("缺省不传 wrongPractice：不渲染（既有调用方零影响）", () => {
    renderView();
    expect(
      screen.queryByRole("button", { name: /练习本卷错题|正在组卷/ }),
    ).toBeNull();
  });
});

// ---------- T4.0b：详解折叠开合回调（host=result 复盘埋点的组件面） ----------

describe("详解折叠开合回调（T4.0b）", () => {
  it("onSolutionToggle 收到该题 questionId、全卷序号与 open/close 动作；缺省不传不报", () => {
    const onSolutionToggle = vi.fn();
    render(
      <AttemptResultView
        data={DATA}
        onBackHome={vi.fn()}
        onSolutionToggle={onSolutionToggle}
      />,
    );
    const folds = screen.getAllByRole("button", { name: /查看详解/ });
    // 第一题的详解折叠：展开 → 收起
    fireEvent.click(folds[0] as HTMLElement);
    fireEvent.click(folds[0] as HTMLElement);
    // DATA 第一题（0 起序号 0）的 questionId 来自夹具
    expect(onSolutionToggle.mock.calls).toEqual([
      [DATA.units[0]?.questions[0]?.questionId, 0, "open"],
      [DATA.units[0]?.questions[0]?.questionId, 0, "close"],
    ]);
  });
});

// ---------- T6R.11：结果页「查看本次草稿原稿」入口 ----------

describe("本次草稿原稿入口（T6R.11）", () => {
  const stubsOf = noteOriginalStubDatasets;

  it("非手写题逐题渲染入口（学生角色 + 本 attempt 定位 + 题目 id）；手写题不渲染", () => {
    renderView();
    const stubs = stubsOf();
    // DATA 四题：判断/单选/填空非手写（有草稿层），solve 手写（不渲染）
    expect(stubs.map((s) => s.question)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-4",
    ]);
    for (const stub of stubs) {
      expect(stub.role).toBe("student");
      expect(stub.attempt).toBe(DATA.attempt.id);
    }
  });

  // ---------- T6R.13：单题完整导出入口（每题一个，含手写题） ----------

  it("逐题渲染 AI 复习包入口：全部题型、学生角色、attempt/题目/全卷题号定位", () => {
    renderView();
    const stubs = reviewPackStubDatasets();
    // DATA 四题全渲染（手写题也有复习包——原稿走笔迹/证据链）
    expect(stubs).toHaveLength(4);
    expect(stubs.map((s) => s.question)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-4",
      "p4-q7",
    ]);
    for (const stub of stubs) {
      expect(stub.role).toBe("student");
      expect(stub.attempt).toBe(DATA.attempt.id);
    }
    // 全卷连续题号（渲染序）
    expect(stubs.map((s) => s.no)).toEqual(["1", "2", "3", "4"]);
  });

  it("轮次标注按来源：作业=本次作业、课程=第 n 次课程练习、错题重练=第 N 次组卷", () => {
    const assignmentView = renderView(); // DATA 作业来源
    expect(stubsOf()[0]?.round).toBe("本次作业");
    assignmentView.unmount();

    // 夹具遵 attemptSummarySchema 来源不变式（superRefine）：course 的
    // assignmentId=null 且 courseId/unitId 有值；wrong 三者恒 null
    const baseUnit = DATA.units[0];
    const courseData: AttemptResultData = {
      ...DATA,
      attempt: {
        ...DATA.attempt,
        sourceType: "course",
        assignmentId: null,
        courseId: "33333333-3333-4333-8333-333333333333",
        unitId: "unit-a",
        attemptNo: 2,
      },
      units: baseUnit === undefined ? [] : [baseUnit],
      courseName: "初一上",
    };
    const { unmount } = render(
      <AttemptResultView data={courseData} onBackHome={vi.fn()} />,
    );
    expect(stubsOf()[0]?.round).toBe("第 2 次课程练习");
    unmount();

    const wrongData: AttemptResultData = {
      ...courseData,
      attempt: {
        ...courseData.attempt,
        sourceType: "wrong",
        assignmentId: null,
        courseId: null,
        unitId: null,
        attemptNo: 3,
      },
    };
    render(<AttemptResultView data={wrongData} onBackHome={vi.fn()} />);
    // wrong 的 attemptNo=该生错题重练组卷计数（含废弃 draft），非每题轮次——
    // 文案不承诺「第 n 轮」
    expect(stubsOf()[0]?.round).toBe("错题重练 · 第 3 次组卷");
  });

  it("轮次标注按来源：lesson=第 n 次讲练；来源行「讲练：讲义标题 · 第 n 次」+ 返回按钮「返回讲练页」（2026-10 讲练一体）", () => {
    const baseUnit = DATA.units[0];
    const lessonData: AttemptResultData = {
      ...DATA,
      attempt: {
        ...DATA.attempt,
        sourceType: "lesson",
        assignmentId: null,
        lectureId: "77777777-7777-4777-8777-777777777777",
        courseId: null,
        unitId: "随堂讲练",
        attemptNo: 2,
      },
      units: baseUnit === undefined ? [] : [baseUnit],
      title: "第1讲 有理数讲练",
      courseName: null,
    };
    render(<AttemptResultView data={lessonData} onBackHome={vi.fn()} />);
    expect(stubsOf()[0]?.round).toBe("第 2 次讲练");
    expect(
      screen.getByText("讲练：第1讲 有理数讲练 · 第 2 次"),
    ).toBeInTheDocument();
    // 来源行不落「作业」兜底；返回按钮默认文案指向讲练页
    expect(screen.queryByText(/^作业/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "返回讲练页" }),
    ).toBeInTheDocument();
  });

  it("ariaPrefix 接线：各题桩带自己的题号前缀", () => {
    renderView();
    const prefixes = stubsOf().map((stub) => stub.prefix);
    expect(prefixes).toEqual(["第 1 题", "第 2 题", "第 3 题"]);
  });

  it("未公布（answersReleased=false）入口仍在——学生看自己的草稿不受答案公布 gate 限制", () => {
    const unreleased: AttemptResultData = { ...DATA, answersReleased: false };
    render(<AttemptResultView data={unreleased} onBackHome={vi.fn()} />);
    // 三个非手写题照常渲染入口（不含手写题）
    expect(stubsOf()).toHaveLength(3);
  });
});

// ---------- T6R.15：结果页订正区入口 ----------

describe("订正区入口（T6R.15）", () => {
  it("所有题型逐题渲染订正区（含手写题）+ 本 attempt/题目定位 + 题号前缀", () => {
    renderView();
    const stubs = correctionStubDatasets();
    // DATA 四题全渲染（订正不依赖草稿层——手写题也有订正入口）
    expect(stubs).toHaveLength(4);
    expect(stubs.map((s) => s.question)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-4",
      "p4-q7",
    ]);
    for (const stub of stubs) {
      expect(stub.attempt).toBe(DATA.attempt.id);
    }
    expect(stubs.map((s) => s.prefix)).toEqual([
      "第 1 题",
      "第 2 题",
      "第 3 题",
      "第 4 题",
    ]);
  });

  it("未公布（answersReleased=false）订正入口仍在（学生自有材料不受 gate 限制）", () => {
    const unreleased: AttemptResultData = { ...DATA, answersReleased: false };
    render(<AttemptResultView data={unreleased} onBackHome={vi.fn()} />);
    expect(correctionStubDatasets()).toHaveLength(4);
  });
});

describe("练习反馈节奏摘要（M4-D3 §13.8）", () => {
  const WORKFLOW_PER_QUESTION: NonNullable<
    AttemptResultData["practiceWorkflow"]
  > = {
    version: 1,
    feedbackMode: "per_question",
    revision: 0,
    canChangeFeedback: false,
    allowedFeedbackModes: ["per_question"],
    canSubmitQuestion: false,
    restrictionReason: null,
    releaseAt: null,
  };
  const WORKFLOW_AFTER_ATTEMPT: NonNullable<
    AttemptResultData["practiceWorkflow"]
  > = {
    ...WORKFLOW_PER_QUESTION,
    feedbackMode: "after_attempt",
    allowedFeedbackModes: ["after_attempt"],
  };

  it("v1 逐题卷显示「作答时逐题反馈」", () => {
    render(
      <AttemptResultView
        data={{ ...DATA, practiceWorkflow: WORKFLOW_PER_QUESTION }}
        onBackHome={vi.fn()}
      />,
    );
    expect(screen.getByText(/反馈节奏：作答时逐题反馈/)).toBeInTheDocument();
  });

  it("v1 整卷卷显示「交卷后反馈」", () => {
    render(
      <AttemptResultView
        data={{ ...DATA, practiceWorkflow: WORKFLOW_AFTER_ATTEMPT }}
        onBackHome={vi.fn()}
      />,
    );
    expect(screen.getByText(/反馈节奏：交卷后反馈/)).toBeInTheDocument();
    expect(screen.queryByText(/按教师公布时间/)).toBeNull();
  });

  it("legacy/lesson 卷（无 practiceWorkflow）不显示节奏摘要行", () => {
    renderView();
    expect(screen.queryByText(/反馈节奏：/)).toBeNull();
  });

  it("after_due 未公布时注明「按教师公布时间」", () => {
    render(
      <AttemptResultView
        data={{
          ...DATA,
          answersReleased: false,
          practiceWorkflow: WORKFLOW_AFTER_ATTEMPT,
        }}
        onBackHome={vi.fn()}
      />,
    );
    expect(screen.getByText(/反馈节奏：交卷后反馈/)).toBeInTheDocument();
    expect(screen.getByText(/按教师公布时间/)).toBeInTheDocument();
  });
});

describe("QM-08 组段：只读题面共用数据解释（/attempts/:id/context → groupSegmentsOfUnit）", () => {
  const mockedContext = vi.mocked(fetchAttemptContextApi);

  /** 三题单单元：gq-1/gq-2 入组、gq-3 独立（题面刻意不含数学） */
  const GROUP_DATA: AttemptResultData = {
    ...DATA,
    units: [
      {
        id: "材料小练",
        title: "材料小练",
        questions: [
          "gq-1",
          "gq-2",
          "gq-3",
        ].map((questionId, i) => ({
          questionId,
          snapshot: {
            id: questionId,
            type: "judge" as const,
            difficulty: 1,
            knowledge: ["读表"],
            stemMd: `第${i + 1}题判断：表内数字为正。[[正确]]`,
            hintCount: 0,
          },
          answers: { kind: "judge" as const, value: true },
          solutionMd: null,
          answer: { kind: "judge" as const, value: true },
          autoCorrect: true,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: true,
          hintsOpened: [],
        })),
      },
    ],
  };

  it("组段渲染：组头一次、共享材料一份、组内/组外题行都齐全", async () => {
    mockedContext.mockResolvedValue({
      attemptId: DATA.attempt.id,
      materials: [
        {
          id: "mat-1",
          title: "四天气温表",
          contentMd:
            "| 日期 | 最高 | 最低 |\n| --- | --- | --- |\n| 周一 | 1 | -3 |",
          anchors: [],
          slots: [],
          mediaPaths: [],
          sourceVersion: 1,
        },
      ],
      groups: [
        {
          id: "grp-1",
          title: "根据材料回答第 1～2 题",
          label: "1～2",
          introMd: "先读表，再判断。",
          materialRefs: [{ material: "mat-1" }],
          questionIds: ["gq-1", "gq-2"],
          sourceVersion: 1,
        },
      ],
    });
    const { findByText } = render(
      <AttemptResultView data={GROUP_DATA} onBackHome={vi.fn()} />,
    );
    // 材料标题出现（等待 context 查询落地）
    expect(await findByText("四天气温表")).toBeInTheDocument();
    const groupBlock = screen.getByLabelText("题组：根据材料回答第 1～2 题");
    expect(within(groupBlock).getByText("先读表，再判断。")).toBeInTheDocument();
    // 共享材料一份（组块外无第二份）
    expect(screen.getAllByText("四天气温表")).toHaveLength(1);
    // 三题行齐全（题号全卷连续）
    expect(screen.getByRole("article", { name: "第 1 题" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "第 2 题" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "第 3 题" })).toBeInTheDocument();
    mockedContext.mockReset();
    mockedContext.mockResolvedValue({
      attemptId: "",
      materials: [],
      groups: [],
    });
  });

  it("上下文读取失败非阻断：全部按独立题段渲染，回看零变化", async () => {
    mockedContext.mockReset();
    mockedContext.mockRejectedValue(new Error("上下文不可用"));
    const { findAllByRole } = render(
      <AttemptResultView data={GROUP_DATA} onBackHome={vi.fn()} />,
    );
    const cards = await findAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(screen.queryByLabelText(/题组：/)).toBeNull();
    expect(screen.queryByText("四天气温表")).toBeNull();
    mockedContext.mockReset();
    mockedContext.mockResolvedValue({
      attemptId: "",
      materials: [],
      groups: [],
    });
  });
});
