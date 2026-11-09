import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  PracticeQuestionProgress,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { AttemptQuestionRail } from "./AttemptQuestionRail";
import type { QuestionNavigationItem } from "./QuestionNavigator";
import { useAttemptNavigationItems } from "./use-attempt-answer-state";

/**
 * 题号导航单源（阶段 B）：useAttemptNavigationItems 产出导航项 + 已答/未答计数 +
 * 第一道未完成题；AttemptQuestionRail 消费它渲染左栏（lg 起常驻；折叠态只剩
 * 展开按钮与当前题号）。
 */

const questions: AttemptQuestionPublic[] = [
  {
    id: "q1",
    type: "choice",
    difficulty: 1,
    knowledge: [],
    stemMd: "1",
    hintCount: 0,
    options: ["A", "B", "C", "D"],
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
  },
  {
    id: "q2",
    type: "fill",
    difficulty: 1,
    knowledge: [],
    stemMd: "甲 [[]]，乙 [[]]",
    hintCount: 0,
    questionRevisionId: "22222222-2222-4222-8222-222222222222",
  },
  {
    id: "q3",
    type: "judge",
    difficulty: 1,
    knowledge: [],
    stemMd: "3",
    hintCount: 0,
    questionRevisionId: "33333333-3333-4333-8333-333333333333",
  },
] as AttemptQuestionPublic[];

describe("useAttemptNavigationItems", () => {
  it("按完整度统计已答/未答，并给出第一道未完成题；标记随集合透传", () => {
    const { result } = renderHook(() =>
      useAttemptNavigationItems({
        flatQuestions: questions,
        answers: {
          q1: { kind: "choice", index: 1 },
          q2: { kind: "fill", values: ["x"] },
        },
        formalInkPresence: new Map(),
        flaggedQuestions: new Set(["q2"]),
        studentFlags: new Set(["q3"]),
        practiceProtocol: "legacy",
        progressById: new Map(),
      }),
    );
    expect(result.current.answered).toBe(1);
    expect(result.current.unanswered).toBe(2);
    expect(result.current.firstIncompleteId).toBe("q2");
    expect(result.current.items.map((item) => item.completion.state)).toEqual([
      "filled",
      "partial",
      "empty",
    ]);
    expect(result.current.items[1]?.flagged).toBe(true);
    expect(result.current.items[2]?.unsure).toBe(true);
    expect(result.current.items[0]?.practice).toBeUndefined();
  });

  it("v1 卷附带逐题提交四态；全部填写时 firstIncompleteId 为 null；入参不变则引用稳定", () => {
    const progressById = new Map<string, PracticeQuestionProgress>([
      [
        "q1",
        {
          questionId: "q1",
          submittedAt: "2026-11-09T00:00:00.000Z",
          feedbackReadable: false,
        } as PracticeQuestionProgress,
      ],
    ]);
    const answers = {
      q1: { kind: "choice" as const, index: 0 },
      q2: { kind: "fill" as const, values: ["a", "b"] },
      q3: { kind: "judge" as const, value: false },
    };
    const props = {
      flatQuestions: questions,
      answers,
      formalInkPresence: new Map<string, boolean>(),
      flaggedQuestions: new Set<string>(),
      studentFlags: new Set<string>(),
      practiceProtocol: "v1" as const,
      progressById,
    };
    const { result, rerender } = renderHook(
      (input) => useAttemptNavigationItems(input),
      { initialProps: props },
    );
    expect(result.current.answered).toBe(3);
    expect(result.current.firstIncompleteId).toBeNull();
    expect(result.current.items[0]?.practice).toEqual({
      submitted: true,
      feedbackReadable: false,
    });
    expect(result.current.items[1]?.practice).toEqual({
      submitted: false,
      feedbackReadable: false,
    });
    const first = result.current;
    rerender(props);
    expect(result.current).toBe(first);
  });
});

describe("AttemptQuestionRail", () => {
  const items: QuestionNavigationItem[] = [
    {
      id: "q1",
      index: 0,
      completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
      flagged: false,
    },
    {
      id: "q2",
      index: 1,
      completion: { state: "empty", filledSlots: 0, expectedSlots: 1 },
      flagged: true,
    },
    {
      id: "q3",
      index: 2,
      completion: { state: "empty", filledSlots: 0, expectedSlots: 1 },
      flagged: false,
    },
  ];

  it("展开态渲染题号点阵与计数，点击题号跳题；可达名不与底栏「答题卡」按钮冲突", () => {
    const onJump = vi.fn();
    const onToggle = vi.fn();
    render(
      <AttemptQuestionRail
        items={items}
        currentId="q2"
        answered={1}
        total={3}
        collapsed={false}
        onToggleCollapsed={onToggle}
        onJump={onJump}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "题号导航" });
    expect(nav).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("已填写 1/3 · 未答 2");
    expect(screen.queryByRole("button", { name: "答题卡" })).toBeNull();
    const tiles = screen.getAllByRole("button", { name: /^第 \d 题/ });
    expect(tiles).toHaveLength(3);
    fireEvent.click(tiles[2] as HTMLElement);
    expect(onJump).toHaveBeenCalledWith("q3");
    fireEvent.click(screen.getByRole("button", { name: "收起题号导航" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("折叠态只剩展开按钮与当前题号；v1 卷附带已提交计数", () => {
    const { rerender } = render(
      <AttemptQuestionRail
        items={items}
        currentId="q3"
        answered={1}
        total={3}
        submittedCount={1}
        collapsed
        onToggleCollapsed={vi.fn()}
        onJump={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("navigation", { name: "题号导航" }),
    ).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "展开题号导航" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^第 \d 题/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("3 / 3");
    rerender(
      <AttemptQuestionRail
        items={items}
        currentId="q3"
        answered={3}
        total={3}
        submittedCount={2}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onJump={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "已填写 3/3 · 全部已填写 · 已提交 2/3",
    );
  });
});
