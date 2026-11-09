import { fireEvent, render } from "@testing-library/react";
import type { PracticeQuestionProgress } from "@tutor/contract";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRACTICE_KEYBOARD_COMMANDS,
  resolveBindings,
} from "@/features/keyboard/command-registry";
import {
  detectKeyboardDeviceForTest,
  resetKeyboardDeviceForTest,
} from "@/features/keyboard/keyboard-device";
import {
  type AttemptKeyboardInput,
  useAttemptKeyboard,
} from "./use-attempt-keyboard";

/**
 * 作答页键盘派发 hook（阶段 B）——列表模式文档级监听：
 * - J / K 按滚动当前题步进切题（尚无当前题时 J 到第一题、K 不动）；
 * - 字母不区分大小写；方向键在列表模式不劫持（保留页面滚动）；
 * - 1–9 作用于焦点所在题卡，否则滚动当前题；已提交只读题不响应；
 * - 文本编辑区、弹层打开、修饰键、偏好关闭时全部静默；
 * - 单题模式不挂文档监听（单题走容器 onKeyDown，既有 practice-single-keyboard 覆盖）。
 */

const QUESTION_IDS = ["q1", "q2", "q3"] as const;

function Harness({
  input,
  cards,
}: {
  input: AttemptKeyboardInput;
  cards: RefObject<Map<string, HTMLLIElement>>;
}) {
  const { onWorkspaceKeyDown } = useAttemptKeyboard(input);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 测试夹具复刻页面的单题键盘容器（tabIndex=-1 的布局容器）
    <div data-slot="practice-single-workspace" onKeyDown={onWorkspaceKeyDown}>
      <ol>
        {QUESTION_IDS.map((id) => (
          <li
            key={id}
            ref={(element) => {
              if (element) cards.current.set(id, element);
              else cards.current.delete(id);
            }}
          >
            <div data-slot="question-surface">
              <label>
                <input
                  type="radio"
                  name={id}
                  value="A"
                  data-option={`${id}-A`}
                />
                A
              </label>
              <label>
                <input
                  type="radio"
                  name={id}
                  value="B"
                  data-option={`${id}-B`}
                />
                B
              </label>
              <input type="text" aria-label={`${id} 文本`} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function makeInput(
  cards: RefObject<Map<string, HTMLLIElement>>,
  overrides: Partial<AttemptKeyboardInput> = {},
): AttemptKeyboardInput {
  return {
    attemptId: "a1",
    singleMode: false,
    keyboardShortcuts: true,
    keyBindings: resolveBindings(PRACTICE_KEYBOARD_COMMANDS, null),
    questionIds: [...QUESTION_IDS],
    resolvedSingleQuestionId: null,
    currentQuestionId: "q2",
    progressById: new Map<string, PracticeQuestionProgress>(),
    practiceSubmit: {
      submittingId: null,
      finished: false,
      firstUnsubmittedId: "q1",
    },
    singleSwitchBlocked: null,
    editor: null,
    cardElements: cards,
    singleWorkspaceRef: createRef<HTMLDivElement>(),
    canSubmitQuestion: true,
    singleAutoSubmit: false,
    online: true,
    denied: false,
    goSingleQuestion: vi.fn(async () => true),
    jumpToQuestion: vi.fn(async () => {}),
    openSubmitDialog: vi.fn(async () => {}),
    runPracticeSubmit: vi.fn(async () => {}),
    openKeyboardHelp: vi.fn(),
    ...overrides,
  };
}

describe("useAttemptKeyboard（列表模式文档级监听）", () => {
  beforeEach(() => {
    detectKeyboardDeviceForTest();
  });
  afterEach(() => {
    resetKeyboardDeviceForTest();
  });

  it("J / K 按滚动当前题步进；大写同样命中；边界不越界", () => {
    const cards = createRef<Map<string, HTMLLIElement>>() as RefObject<
      Map<string, HTMLLIElement>
    >;
    cards.current = new Map();
    const input = makeInput(cards);
    const { rerender } = render(<Harness input={input} cards={cards} />);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).toHaveBeenLastCalledWith("q3");
    fireEvent.keyDown(document.body, { key: "K" });
    expect(input.jumpToQuestion).toHaveBeenLastCalledWith("q1");
    expect(input.jumpToQuestion).toHaveBeenCalledTimes(2);
    // 末题按 J 不越界
    rerender(
      <Harness input={{ ...input, currentQuestionId: "q3" }} cards={cards} />,
    );
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).toHaveBeenCalledTimes(2);
    // 尚无当前题：J 到第一题，K 不动
    rerender(
      <Harness input={{ ...input, currentQuestionId: null }} cards={cards} />,
    );
    fireEvent.keyDown(document.body, { key: "k" });
    expect(input.jumpToQuestion).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).toHaveBeenLastCalledWith("q1");
  });

  it("方向键在列表模式不劫持（保留页面原生滚动）", () => {
    const cards = createRef<Map<string, HTMLLIElement>>() as RefObject<
      Map<string, HTMLLIElement>
    >;
    cards.current = new Map();
    const input = makeInput(cards);
    render(<Harness input={input} cards={cards} />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
  });

  it("1–9 点选焦点所在题卡的选项；焦点不在题卡时作用于滚动当前题；已提交题不响应", () => {
    const cards = createRef<Map<string, HTMLLIElement>>() as RefObject<
      Map<string, HTMLLIElement>
    >;
    cards.current = new Map();
    const input = makeInput(cards);
    const { container, rerender } = render(
      <Harness input={input} cards={cards} />,
    );
    const optionOf = (name: string) =>
      container.querySelector<HTMLInputElement>(`[data-option="${name}"]`);
    // 焦点在 q1 的单选 A 上 → 2 选 q1 的 B
    optionOf("q1-A")?.focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "2" });
    expect(optionOf("q1-B")?.checked).toBe(true);
    // 焦点回 body → 作用于滚动当前题 q2
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "1" });
    expect(optionOf("q2-A")?.checked).toBe(true);
    expect(optionOf("q3-A")?.checked).toBe(false);
    // 当前题已提交只读：不响应
    const submitted = new Map<string, PracticeQuestionProgress>([
      [
        "q3",
        {
          questionId: "q3",
          submittedAt: "2026-11-09T00:00:00.000Z",
          feedbackReadable: true,
        } as PracticeQuestionProgress,
      ],
    ]);
    rerender(
      <Harness
        input={{ ...input, currentQuestionId: "q3", progressById: submitted }}
        cards={cards}
      />,
    );
    fireEvent.keyDown(document.body, { key: "1" });
    expect(optionOf("q3-A")?.checked).toBe(false);
  });

  it("文本编辑区内按键、弹层打开、修饰键、偏好关闭时全部静默", () => {
    const cards = createRef<Map<string, HTMLLIElement>>() as RefObject<
      Map<string, HTMLLIElement>
    >;
    cards.current = new Map();
    const input = makeInput(cards);
    const { container, rerender } = render(
      <Harness input={input} cards={cards} />,
    );
    const text = container.querySelector<HTMLInputElement>(
      'input[aria-label="q2 文本"]',
    );
    text?.focus();
    fireEvent.keyDown(text ?? document.body, { key: "j" });
    fireEvent.keyDown(text ?? document.body, { key: "1" });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>('[data-option="q2-A"]')
        ?.checked,
    ).toBe(false);
    text?.blur();
    // 修饰键组合不是快捷键
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
    // 弹层打开
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
    dialog.remove();
    // 偏好关闭：监听不挂
    rerender(
      <Harness input={{ ...input, keyboardShortcuts: false }} cards={cards} />,
    );
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
  });

  it("单题模式不挂文档级监听；卸载后移除监听", () => {
    const cards = createRef<Map<string, HTMLLIElement>>() as RefObject<
      Map<string, HTMLLIElement>
    >;
    cards.current = new Map();
    const input = makeInput(cards, {
      singleMode: true,
      resolvedSingleQuestionId: "q2",
    });
    const { unmount, rerender } = render(
      <Harness input={input} cards={cards} />,
    );
    fireEvent.keyDown(document.body, { key: "j" });
    expect(input.jumpToQuestion).not.toHaveBeenCalled();
    expect(input.goSingleQuestion).not.toHaveBeenCalled();
    const listInput = makeInput(cards);
    rerender(<Harness input={listInput} cards={cards} />);
    unmount();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(listInput.jumpToQuestion).not.toHaveBeenCalled();
  });
});
