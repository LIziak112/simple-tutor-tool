import { act, render } from "@testing-library/react";
import type { QuestionPublic } from "@tutor/contract";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
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

type Entry = { target: Element; isIntersecting: boolean };

/**
 * 行级懒挂载走窗口控制器（mountWindow 未传时行内自建实例），观察器由
 * 控制器按 rootMargin 区分挂载带/卸载窗口；这里用假观察器驱动时序。
 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  callback: (entries: Entry[]) => void;
  options: IntersectionObserverInit;
  constructor(
    callback: (entries: Entry[]) => void,
    options: IntersectionObserverInit = {},
  ) {
    this.callback = callback;
    this.options = options;
    FakeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function observerByMargin(rootMargin: string): FakeObserver {
  const found = FakeObserver.instances.find(
    (instance) => instance.options.rootMargin === rootMargin,
  );
  if (found === undefined) throw new Error(`no observer for ${rootMargin}`);
  return found;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("视口懒挂载：未进入视口只渲染等高占位，进入后挂载；整行远离后卸回实测等高占位", async () => {
  vi.useFakeTimers();
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.mocked(AttemptQuestionCard).mockClear();
  const view = render(
    <AttemptQuestionRow {...rowProps({ lazyMount: true })} />,
  );
  expect(vi.mocked(AttemptQuestionCard)).not.toHaveBeenCalled();
  expect(
    view.container.querySelector('[data-slot="question-placeholder"]'),
  ).not.toBeNull();
  expect(view.container.querySelector("li")?.hidden).toBe(false);
  const li = view.container.querySelector("li");
  expect(li).not.toBeNull();
  act(() => {
    observerByMargin("50% 0px 100% 0px").callback([
      { target: li as Element, isIntersecting: true },
    ]);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.mocked(AttemptQuestionCard)).toHaveBeenCalledTimes(1);
  expect(
    view.container.querySelector('[data-slot="question-placeholder"]'),
  ).toBeNull();
  // 窗口化卸载：整行完全离开卸载窗口后卸回占位，占位回填实测卡高
  // （实测读的是 li 的首个子元素——挂载的题卡根节点）。
  const card = li?.firstElementChild as HTMLElement | null;
  if (card === null) throw new Error("挂载后 li 首子元素（题卡）不存在");
  card.getBoundingClientRect = () => ({ height: 623 }) as DOMRect;
  Object.defineProperty(li, "getBoundingClientRect", {
    value: () => ({ top: -30000, bottom: -29500, height: 500 }) as DOMRect,
    configurable: true,
  });
  act(() => {
    observerByMargin("250% 0px 250% 0px").callback([
      { target: li as Element, isIntersecting: false },
    ]);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  const placeholder = view.container.querySelector<HTMLElement>(
    '[data-slot="question-placeholder"]',
  );
  expect(placeholder).not.toBeNull();
  expect(placeholder?.style.minHeight).toBe("623px");
});

it("视口懒挂载：forceMount 跳过视口判断直接挂载", () => {
  vi.mocked(AttemptQuestionCard).mockClear();
  const view = render(
    <AttemptQuestionRow {...rowProps({ lazyMount: true, forceMount: true })} />,
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
    <AttemptQuestionRow {...rowProps({ lazyMount: false, onCardMounted })} />,
  );
  expect(onCardMounted).toHaveBeenCalledWith("q1");
});

it("视口懒挂载：会话级共享控制器驱动挂载与卸载", async () => {
  vi.useFakeTimers();
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.mocked(AttemptQuestionCard).mockClear();
  const { LazyMountWindow } = await import("./lazy-mount-window");
  const shared = new LazyMountWindow();
  const view = render(
    <AttemptQuestionRow
      {...rowProps({ lazyMount: true, mountWindow: shared })}
    />,
  );
  expect(vi.mocked(AttemptQuestionCard)).not.toHaveBeenCalled();
  const li = view.container.querySelector("li");
  act(() => {
    observerByMargin("50% 0px 100% 0px").callback([
      { target: li as Element, isIntersecting: true },
    ]);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.mocked(AttemptQuestionCard)).toHaveBeenCalledTimes(1);
  shared.dispose();
});
