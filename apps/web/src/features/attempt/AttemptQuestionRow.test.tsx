import { act, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { QuestionPublic } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import { AttemptQuestionRow } from "./AttemptQuestionRow";

vi.mock("./AttemptQuestionCard", () => ({
  AttemptQuestionCard: vi.fn(() => <div>题面</div>),
}));
it("仅顶栏保存状态更新时不重渲染题面；答案或待检查变化必须更新", () => {
  const question: QuestionPublic = {
    id: "q",
    type: "judge",
    stemMd: "题面",
    difficulty: 1,
    knowledge: [],
    hintCount: 0,
  };
  const props = {
    question,
    answer: undefined,
    index: 0,
    onAnswer: vi.fn(),
    onToggleFlag: vi.fn(),
    onToggleUnsure: vi.fn(),
    onHintUnlocked: vi.fn(),
    cardElements: { current: new Map<string, HTMLElement>() },
    events: {
      registerCard: vi.fn(),
      noteInteraction: vi.fn(),
      trackInkStrokes: vi.fn(),
      trackInkEdit: vi.fn(),
      trackInkFullscreen: vi.fn(),
    },
  };
  const { rerender } = render(<AttemptQuestionRow {...props} />);
  const before = vi.mocked(AttemptQuestionCard).mock.calls.length;
  rerender(<AttemptQuestionRow {...props} />);
  expect(vi.mocked(AttemptQuestionCard).mock.calls.length).toBe(before);
  rerender(<AttemptQuestionRow {...props} flagged />);
  expect(vi.mocked(AttemptQuestionCard).mock.calls.length).toBe(before + 1);
  rerender(
    <AttemptQuestionRow
      {...props}
      flagged
      answer={{ kind: "judge", value: false }}
    />,
  );
  expect(vi.mocked(AttemptQuestionCard).mock.calls.length).toBe(before + 2);
  const previous = vi.mocked(AttemptQuestionCard).mock.lastCall?.[0].onAnswer;
  rerender(
    <AttemptQuestionRow
      {...props}
      aiTrigger={<button type="button">AI 助教</button>}
      aiContent={<p>当前回复</p>}
      flagged
      answer={{ kind: "judge", value: false }}
    />,
  );
  expect(vi.mocked(AttemptQuestionCard).mock.lastCall?.[0].onAnswer).toBe(
    previous,
  );
  const onAnswer = vi.fn();
  rerender(<AttemptQuestionRow {...props} onAnswer={onAnswer} />);
  vi.mocked(AttemptQuestionCard).mock.lastCall?.[0].onAnswer(
    { kind: "judge", value: true },
    true,
  );
  expect(onAnswer).toHaveBeenCalledWith(
    question.id,
    { kind: "judge", value: true },
    true,
  );
});

type RowTestProps = ComponentProps<typeof AttemptQuestionRow>;

function rowProps(overrides: Partial<RowTestProps> = {}): RowTestProps {
  const question: QuestionPublic = {
    id: "q1",
    type: "judge",
    stemMd: "题面",
    difficulty: 1,
    knowledge: [],
    hintCount: 0,
  };
  return {
    question,
    answer: undefined,
    index: 0,
    onAnswer: vi.fn(),
    onToggleFlag: vi.fn(),
    onToggleUnsure: vi.fn(),
    onHintUnlocked: vi.fn(),
    cardElements: { current: new Map<string, HTMLElement>() },
    events: {
      registerCard: vi.fn(),
      noteInteraction: vi.fn(),
      trackInkStrokes: vi.fn(),
      trackInkEdit: vi.fn(),
      trackInkFullscreen: vi.fn(),
    },
    ...overrides,
  };
}

it("视口懒挂载：未进入视口只渲染等高占位，进入视口后挂载题卡", () => {
  const callbacks: Array<
    (entries: Array<{ isIntersecting: boolean }>) => void
  > = [];
  class FakeObserver {
    constructor(
      callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    ) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.mocked(AttemptQuestionCard).mockClear();
  const view = render(
    <AttemptQuestionRow {...rowProps({ lazyMount: true })} />,
  );
  expect(vi.mocked(AttemptQuestionCard)).not.toHaveBeenCalled();
  const placeholder = view.container.querySelector(
    '[data-slot="question-placeholder"]',
  );
  expect(placeholder).not.toBeNull();
  expect(view.container.querySelector("li")?.hidden).toBe(false);
  act(() => {
    for (const callback of callbacks) callback([{ isIntersecting: true }]);
  });
  expect(vi.mocked(AttemptQuestionCard)).toHaveBeenCalledTimes(1);
  expect(
    view.container.querySelector('[data-slot="question-placeholder"]'),
  ).toBeNull();
  vi.unstubAllGlobals();
});

it("视口懒挂载：forceMount 跳过视口判断直接挂载", () => {
  vi.mocked(AttemptQuestionCard).mockClear();
  const view = render(
    <AttemptQuestionRow
      {...rowProps({ lazyMount: true, forceMount: true })}
    />,
  );
  expect(vi.mocked(AttemptQuestionCard)).toHaveBeenCalled();
  expect(
    view.container.querySelector('[data-slot="question-placeholder"]'),
  ).toBeNull();
});

it("视口懒挂载：关闭懒挂载时始终渲染题卡（单题模式口径）", () => {
  vi.mocked(AttemptQuestionCard).mockClear();
  render(<AttemptQuestionRow {...rowProps({ lazyMount: false })} />);
  expect(vi.mocked(AttemptQuestionCard)).toHaveBeenCalledTimes(1);
});

it("视口懒挂载：挂载完成回调只报一次", () => {
  const onCardMounted = vi.fn();
  render(
    <AttemptQuestionRow
      {...rowProps({ lazyMount: false, onCardMounted })}
    />,
  );
  expect(onCardMounted).toHaveBeenCalledWith("q1");
});
