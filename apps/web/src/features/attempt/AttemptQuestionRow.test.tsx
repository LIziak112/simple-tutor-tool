import { render } from "@testing-library/react";
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
