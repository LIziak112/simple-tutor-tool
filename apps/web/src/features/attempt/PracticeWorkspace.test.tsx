import { fireEvent, render, screen } from "@testing-library/react";
import type { PracticeLayout, PracticeQuestionProgress } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PracticeLayoutMenuItems,
  PracticeModeSummary,
  SingleQuestionActionBar,
  SingleQuestionProgressRow,
} from "./PracticeWorkspace";
import {
  firstUnsubmittedQuestionId,
  practiceProtocolOfDraft,
} from "./practice-protocol";
import { workflowOf } from "./practice-test-fixtures";
import type { QuestionNavigationItem } from "./QuestionNavigator";
import { QuestionNavigator } from "./QuestionNavigator";

/**
 * M3-D1 工作区呈现骨架：v1 新协议卷的做题方式摘要行（含受限文案）、
 * 单题紧凑进度行、占位主操作条、「更多」菜单切换项与题目导航四态标记；
 * 统一公布模式下已提交行不得出现红绿对错或正确率暗示（计划 §7.1/§9.1）。
 */

// ---------- 纯 helper：协议判别与定位 ----------

it("协议判别：无 practiceWorkflow 或 lesson 来源恒旧协议（列表呈现零变化）", () => {
  expect(
    practiceProtocolOfDraft({
      attempt: { sourceType: "course" },
    }),
  ).toBe("legacy");
  expect(
    practiceProtocolOfDraft({
      attempt: { sourceType: "course" },
      practiceWorkflow: workflowOf(),
    }),
  ).toBe("v1");
  // lesson 独立适配：即使异常携带 workflow 也不接管
  expect(
    practiceProtocolOfDraft({
      attempt: { sourceType: "lesson" },
      practiceWorkflow: workflowOf(),
    }),
  ).toBe("legacy");
});

it("首道未提交题定位：跳过已提交，全提交返回 null 由调用方兜底", () => {
  const progress: PracticeQuestionProgress[] = [
    {
      questionId: "q1",
      submittedAt: "2026-10-22T02:00:00.000Z",
      feedbackReadable: true,
    },
    { questionId: "q2", submittedAt: null, feedbackReadable: false },
    { questionId: "q3", submittedAt: null, feedbackReadable: false },
  ];
  expect(firstUnsubmittedQuestionId(["q1", "q2", "q3"], progress)).toBe("q2");
  expect(firstUnsubmittedQuestionId(["q1"], [])).toBe("q1");
  const allSubmitted: PracticeQuestionProgress[] = [
    {
      questionId: "q1",
      submittedAt: "2026-10-22T02:00:00.000Z",
      feedbackReadable: false,
    },
  ];
  expect(firstUnsubmittedQuestionId(["q1"], allSubmitted)).toBeNull();
});

// ---------- 摘要行（PracticeModeSummary） ----------

it("v1 可逐题卷显示当前布局摘要，展开可改本次布局", () => {
  const onLayoutChange = vi.fn();
  const { rerender } = render(
    <PracticeModeSummary
      workflow={workflowOf()}
      layout="list"
      onLayoutChange={onLayoutChange}
    />,
  );
  expect(screen.getByText(/列表 · 每题提交后查看/)).toBeInTheDocument();
  // 展开后切换布局（本次作答即时生效）
  fireEvent.click(screen.getByRole("button", { name: /调整做题方式/ }));
  fireEvent.click(screen.getByRole("radio", { name: /单题专注/ }));
  expect(onLayoutChange).toHaveBeenCalledWith("single");
  rerender(
    <PracticeModeSummary
      workflow={workflowOf()}
      layout="single"
      onLayoutChange={onLayoutChange}
    />,
  );
  expect(screen.getByText(/单题 · 每题提交后查看/)).toBeInTheDocument();
});

it("反馈节奏为交卷后查看时摘要显示交卷后查看", () => {
  render(
    <PracticeModeSummary
      workflow={workflowOf({
        feedbackMode: "after_attempt",
        allowedFeedbackModes: ["after_attempt"],
      })}
      layout="list"
      onLayoutChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/列表 · 交卷后查看/)).toBeInTheDocument();
});

it("受限卷显示受限原因，紧邻节奏描述（老师要求交卷后/截止后公布）", () => {
  const { rerender } = render(
    <PracticeModeSummary
      workflow={workflowOf({
        feedbackMode: "after_attempt",
        canChangeFeedback: false,
        allowedFeedbackModes: ["after_attempt"],
        canSubmitQuestion: false,
        restrictionReason: "teacher_after_attempt",
      })}
      layout="list"
      onLayoutChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/列表 · 交卷后查看/)).toBeInTheDocument();
  expect(screen.getByText(/老师要求交卷后公布/)).toBeInTheDocument();
  rerender(
    <PracticeModeSummary
      workflow={workflowOf({
        feedbackMode: "after_attempt",
        canChangeFeedback: false,
        allowedFeedbackModes: ["after_attempt"],
        canSubmitQuestion: false,
        restrictionReason: "teacher_after_due",
        releaseAt: "2026-11-01T12:00:00.000Z",
      })}
      layout="single"
      onLayoutChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/单题 · 交卷后查看/)).toBeInTheDocument();
  expect(screen.getByText(/老师要求截止后公布/)).toBeInTheDocument();
});

it("未受限卷不显示受限文案", () => {
  render(
    <PracticeModeSummary
      workflow={workflowOf()}
      layout="list"
      onLayoutChange={vi.fn()}
    />,
  );
  expect(screen.queryByText(/老师要求/)).toBeNull();
});

// ---------- 单题紧凑进度行与占位主操作条 ----------

it("紧凑进度行显示第 n / N 题与已提交计数，题目导航入口可打开", () => {
  const onOpenNavigator = vi.fn();
  render(
    <SingleQuestionProgressRow
      current={8}
      total={20}
      submittedCount={7}
      onOpenNavigator={onOpenNavigator}
    />,
  );
  expect(screen.getByText("第 8 / 20 题 · 已提交 7 题")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "题目导航" }));
  expect(onOpenNavigator).toHaveBeenCalled();
});

it("占位主操作条：上一题/下一题可达且首末题禁用；中间为占位容器", () => {
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const { rerender } = render(
    <SingleQuestionActionBar
      hasPrev={false}
      hasNext
      onPrev={onPrev}
      onNext={onNext}
    />,
  );
  expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
  const next = screen.getByRole("button", { name: "下一题" });
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(onNext).toHaveBeenCalled();
  expect(
    document.querySelector('[data-slot="practice-action-placeholder"]'),
  ).not.toBeNull();
  rerender(
    <SingleQuestionActionBar
      hasPrev
      hasNext={false}
      onPrev={onPrev}
      onNext={onNext}
    />,
  );
  expect(screen.getByRole("button", { name: "上一题" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "下一题" })).toBeDisabled();
});

// ---------- 「更多」菜单切换项 ----------

it("菜单切换项标记当前布局，点击即时切换不写默认偏好", () => {
  const onChange = vi.fn();
  const show = (layout: PracticeLayout) =>
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">更多</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <PracticeLayoutMenuItems layout={layout} onChange={onChange} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  const { rerender } = show("list");
  expect(
    screen.getByRole("menuitemradio", { name: /做题方式：列表/ }),
  ).toHaveAttribute("aria-checked", "true");
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  expect(onChange).toHaveBeenCalledWith("single");
  rerender(
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <button type="button">更多</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <PracticeLayoutMenuItems layout="single" onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  expect(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  ).toHaveAttribute("aria-checked", "true");
});

// ---------- 题目导航四态（QuestionNavigator 扩展） ----------

const practiceItems: QuestionNavigationItem[] = [
  {
    id: "a",
    index: 0,
    completion: { state: "empty", filledSlots: 0, expectedSlots: 1 },
    flagged: false,
  },
  {
    id: "b",
    index: 1,
    completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
    flagged: false,
  },
  {
    id: "c",
    index: 2,
    completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
    flagged: false,
    practice: { submitted: true, feedbackReadable: true },
  },
  {
    id: "d",
    index: 3,
    completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
    flagged: false,
    practice: { submitted: true, feedbackReadable: false },
  },
];

it("四态标记：未答/已填未交/已提交/已提交待公布可区分", () => {
  render(
    <QuestionNavigator items={practiceItems} currentId="a" onJump={vi.fn()} />,
  );
  expect(
    screen.getByRole("button", { name: "第 1 题，未填写" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "第 2 题，已填写" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "第 3 题，已提交" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "第 4 题，已提交，反馈待公布" }),
  ).toBeInTheDocument();
  // 已提交与未提交样式互异，两种已提交态之间也互异
  const classes = practiceItems.map(
    (item) =>
      screen.getByRole("button", {
        name: new RegExp(`第 ${item.index + 1} 题`),
      }).className,
  );
  expect(new Set(classes).size).toBe(4);
  // 图例覆盖新状态
  expect(screen.getByText(/^已提交$/)).toBeInTheDocument();
  expect(screen.getByText("已提交 · 待公布")).toBeInTheDocument();
});

it("统一公布模式：已提交行无红绿对错与正确率暗示", () => {
  render(
    <QuestionNavigator items={practiceItems} currentId="a" onJump={vi.fn()} />,
  );
  for (const item of practiceItems.filter((i) => i.practice?.submitted)) {
    const button = screen.getByRole("button", {
      name: new RegExp(`第 ${item.index + 1} 题`),
    });
    expect(button.textContent).not.toMatch(/对|错|正确|得分|成绩/);
    expect(button.className).not.toMatch(
      /destructive|red|green|emerald|rose|correct|wrong/i,
    );
  }
});

it("全部已提交且未填时下一道未答仍指向未填未提交题", () => {
  const jump = vi.fn();
  const items: QuestionNavigationItem[] = [
    {
      id: "a",
      index: 0,
      completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
      flagged: false,
      practice: { submitted: true, feedbackReadable: true },
    },
    {
      id: "b",
      index: 1,
      completion: { state: "empty", filledSlots: 0, expectedSlots: 1 },
      flagged: false,
    },
  ];
  render(<QuestionNavigator items={items} currentId="a" onJump={jump} />);
  fireEvent.click(screen.getByRole("button", { name: "下一道未答" }));
  expect(jump).toHaveBeenCalledWith("b");
  expect(
    screen.queryByRole("button", { name: "全部已填写" }),
  ).not.toBeInTheDocument();
});
