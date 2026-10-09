import { fireEvent, render, screen } from "@testing-library/react";
import type { AttemptResultData } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { reviewPackStubDatasets } from "@/features/export/review-pack-test-stub";
import { correctionStubDatasets } from "@/features/notes/correction-test-stub";
import { noteOriginalStubDatasets } from "@/features/notes/note-original-test-stub";
import { AttemptResultView } from "./AttemptResultView";

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

const DATA: AttemptResultData = {
  attempt: {
    id: "55555555-5555-4555-8555-555555555555",
    sourceType: "assignment",
    assignmentId: "44444444-4444-4444-8444-444444444444",
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
  it("显示得分、对/错/待批与未答计数（D1：未答独立展示）与交卷时间", () => {
    renderView();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/自动判分得分/)).toBeInTheDocument();
    // 计数行内含 <b> 强调，文本被拆分为多个节点——用整体文本断言
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("共 4 题");
    expect(bodyText).toContain("答对 1 题");
    expect(bodyText).toContain("答错 2 题");
    expect(bodyText).toContain("待批 1 题");
    expect(bodyText).toContain("未答 1 题");
    expect(screen.getByText(/交卷时间：/)).toBeInTheDocument();
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

  it("本人答案 vs 参考答案；无标准答案显示「由老师批改后公布」", () => {
    renderView();
    expect(screen.getAllByText("你的答案：").length).toBe(4);
    // 答错的单选：你的答案 A / 参考答案 B（选项字母行也会出现 A/B，取全部）
    expect(screen.getAllByText("A").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("B").length).toBeGreaterThanOrEqual(2);
    // 未作答的手写题
    expect(screen.getByText("未作答")).toBeInTheDocument();
    expect(screen.getByText("由老师批改后公布")).toBeInTheDocument();
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

  it("手写题显示「我的手写笔迹」缩略图（学生本人 PNG 直出）；客观题不显示", () => {
    renderView();
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

  it("汇总卡替换为「已交卷，答案将在截止后公布」横幅：无得分数字、无对错计数、含截止时间与已答统计", () => {
    render(<AttemptResultView data={RESTRICTED} onBackHome={vi.fn()} />);
    expect(screen.getByText(/已交卷，答案将在截止后公布/)).toBeInTheDocument();
    expect(screen.getByText(/截止时间：/)).toBeInTheDocument();
    expect(screen.queryByText(/自动判分得分/)).toBeNull();
    expect(screen.queryByText("60")).toBeNull();
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("答对");
    expect(bodyText).not.toContain("答错");
    expect(bodyText).not.toContain("待批");
    expect(bodyText).toContain("已作答 3 题 / 共 4 题");
    // 标题后缀从「批改结果」换成「已交卷」
    expect(screen.getByText(/周末加练 · 已交卷/)).toBeInTheDocument();
  });

  it("逐题卡只渲染本人作答内容：无对错图标、无参考答案、无详解；本人答案与已解锁提示保留", () => {
    render(<AttemptResultView data={RESTRICTED} onBackHome={vi.fn()} />);
    expect(screen.queryAllByLabelText("答对").length).toBe(0);
    expect(screen.queryAllByLabelText("答错").length).toBe(0);
    expect(screen.queryAllByLabelText("待批改").length).toBe(0);
    expect(screen.queryAllByText("参考答案：").length).toBe(0);
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
    expect(screen.getByText(/最终得分（含老师批改/)).toBeInTheDocument();
    // 回归：不再显示旧口径的自动判分标签
    expect(screen.queryByText(/自动判分得分/)).toBeNull();
    // pendingCount=0（summary.pending 仍为 1，展示以权威计数为准；
    // 计数行内 <b> 拆分文本节点，用整体文本断言）
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("待批 0 题");
    expect(bodyText).not.toContain("待批 1 题");
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
    // 用块标题「老师批改：」区分（题内另有「由老师批改后公布」的参考答案占位文案）
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
