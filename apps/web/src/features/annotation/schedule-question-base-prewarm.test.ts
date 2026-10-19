import type { AttemptQuestionPublic } from "@tutor/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cancelQuestionBasePrewarm,
  interruptQuestionBasePrewarm,
  prewarmQuestionBase,
} from "./question-base-prewarm";
import { scheduleQuestionBasePrewarm } from "./schedule-question-base-prewarm";

vi.mock("./question-base-prewarm", () => ({
  prewarmQuestionBase: vi.fn(async () => {}),
  cancelQuestionBasePrewarm: vi.fn(),
  interruptQuestionBasePrewarm: vi.fn(),
}));
const session = { origin: "https://warm.test", studentId: "s" };
const scope = { attemptId: "a", questionId: "q", phase: "scratch" as const };
const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "r",
  type: "solve",
  stemMd: "公开题面",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
const surface = document.createElement("div");
let observerCallback: IntersectionObserverCallback;
let idleCallback: IdleRequestCallback;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.appendChild(surface);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleCallback = callback;
    return 1;
  });
  vi.stubGlobal("cancelIdleCallback", vi.fn());
});
afterEach(() => {
  surface.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("没有空闲回调时延后预备，离开可见区域会取消定时任务", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  const stop = scheduleQuestionBasePrewarm(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  try {
    visible(true);
    await vi.advanceTimersByTimeAsync(749);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    visible(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    visible(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(prewarmQuestionBase).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
function visible(value: boolean) {
  observerCallback(
    [
      {
        target: surface,
        isIntersecting: value,
        time: 0,
        boundingClientRect: new DOMRect(),
        intersectionRect: new DOMRect(),
        rootBounds: null,
        intersectionRatio: value ? 1 : 0,
      },
    ],
    {} as IntersectionObserver,
  );
}
function idle() {
  idleCallback({ didTimeout: false, timeRemaining: () => 20 });
}
it("仅可见、非编辑题面在空闲时预备；离开可见区域取消", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleCallback = callback;
    return 1;
  });
  const stop = scheduleQuestionBasePrewarm(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  try {
    visible(false);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    visible(true);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(749);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    idle();
    await Promise.resolve();
    expect(prewarmQuestionBase).toHaveBeenCalledOnce();
    visible(false);
    expect(cancelQuestionBasePrewarm).toHaveBeenCalled();
  } finally {
    stop();
  }
});
it("在途候选忙于编辑或已卸载不启动预备", () => {
  let busy = false;
  const stop = scheduleQuestionBasePrewarm(
    session,
    scope,
    question,
    surface,
    () => busy,
  );
  visible(true);
  busy = true;
  idle();
  expect(prewarmQuestionBase).not.toHaveBeenCalled();
  busy = false;
  visible(true);
  stop();
  idle();
  expect(prewarmQuestionBase).not.toHaveBeenCalled();
});
it("交互停止后才空闲预备，任意按下会取消在途任务", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleCallback = callback;
    return 1;
  });
  const stop = scheduleQuestionBasePrewarm(
    session,
    scope,
    question,
    surface,
    () => false,
  );
  try {
    visible(true);
    await vi.advanceTimersByTimeAsync(749);
    expect(prewarmQuestionBase).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(750);
    idle();
    await Promise.resolve();
    expect(prewarmQuestionBase).toHaveBeenCalledOnce();
    vi.mocked(interruptQuestionBasePrewarm).mockClear();
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(interruptQuestionBasePrewarm).toHaveBeenCalled();
  } finally {
    stop();
  }
});
