import { fireEvent, render, screen } from "@testing-library/react";
import type { AttemptResultData } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { AttemptResultView } from "./AttemptResultView";

/**
 * 结果视图组件测试（T2.6）：得分汇总（scoreAuto/对错待批/未答说明）、
 * 逐题 ✓/✗/待批图标、本人答案 vs 参考答案、详解默认折叠、返回首页。
 */

const DATA: AttemptResultData = {
  attempt: {
    id: "55555555-5555-4555-8555-555555555555",
    sourceType: "assignment",
    assignmentId: "44444444-4444-4444-8444-444444444444",
    courseId: null,
    unitId: "练习四",
    attemptNo: 1,
    status: "submitted",
    startedAt: "2026-09-27T02:00:00.000Z",
    submittedAt: "2026-09-27T02:30:00.000Z",
    scoreAuto: 60,
  },
  title: "周末加练",
  courseName: null,
  dueAt: null,
  summary: {
    total: 4,
    answered: 3,
    correct: 1,
    wrong: 2,
    pending: 1,
    unanswered: 1,
    autoGradable: 3,
  },
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
      hintsOpened: [],
    },
  ],
};

function renderView(onBackHome = vi.fn()) {
  return render(<AttemptResultView data={DATA} onBackHome={onBackHome} />);
}

describe("得分汇总卡", () => {
  it("显示得分、对/错/待批计数（含未答说明）与交卷时间", () => {
    renderView();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText(/自动判分得分/)).toBeInTheDocument();
    // 计数行内含 <b> 强调，文本被拆分为多个节点——用整体文本断言
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("共 4 题");
    expect(bodyText).toContain("答对 1 题");
    expect(bodyText).toContain("答错 2 题");
    expect(bodyText).toContain("待批 1 题（含未答 1 题）");
    expect(screen.getByText(/交卷时间：/)).toBeInTheDocument();
  });

  it("返回首页按钮触发回调", () => {
    const onBackHome = vi.fn();
    renderView(onBackHome);
    fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
    expect(onBackHome).toHaveBeenCalledTimes(1);
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
