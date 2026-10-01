import { act, render } from "@testing-library/react";
import type { StudentAnswer } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import { useAttemptEvents } from "./use-attempt-events";

/**
 * useAttemptEvents 的 T4.0b 新增面测试：
 * - trackInkEdit：四计数按题聚合、防抖窗口到点合并为一条 ink_edit_batch；
 *   交卷（finalizeSubmit）与卸载前未到期批次冲出；
 * - trackInkFullscreen：ink_fullscreen{on} 直报；
 * - trackHintUnlock：directive_interact{host:question, hint, open, index}——
 *   index 与 hint_open 服务端直记同口径（0 起解锁序号）。
 * 队列出网经 api mock 观察（postAttemptEventsApi）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    postAttemptEventsApi: vi.fn(async () => ({ accepted: 1 })),
  };
});

// vi.mock 提升后动态 import 拿 mock 实例（与组件测试的 vi.mocked 模式一致）
const { postAttemptEventsApi } = await import("@/lib/api");
const mockedPost = vi.mocked(postAttemptEventsApi);

interface HarnessApi {
  trackInkEdit(
    questionId: string,
    reason: "erase" | "undo" | "redo" | "clear",
  ): void;
  trackInkFullscreen(questionId: string, on: boolean): void;
  trackHintUnlock(questionId: string, index: number): void;
  finalizeSubmit(): Promise<void>;
  noteInteraction(questionId: string): void;
  trackAnswerChange(questionId: string, answer: StudentAnswer): void;
}

function renderHook(attemptId: string): {
  api: HarnessApi;
  unmount: () => void;
} {
  let api: HarnessApi | null = null;
  function Probe() {
    api = useAttemptEvents(attemptId);
    return null;
  }
  const { unmount } = render(<Probe />);
  if (api === null) throw new Error("Probe 未渲染（renderHook 实现缺陷）");
  return { api, unmount };
}

type PostedEvent = Record<string, unknown>;

/** 收集全部已出网事件 */
async function flushedEvents(): Promise<PostedEvent[]> {
  await act(async () => {
    await Promise.resolve();
  });
  return mockedPost.mock.calls.flatMap(
    (call) => call[1] as unknown as PostedEvent[],
  );
}

beforeEach(() => {
  installEventStore(memoryEventStore());
  mockedPost.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAttemptEvents：ink_edit_batch 聚合（T4.0b）", () => {
  it("窗口内连续编辑合并为一条四计数事件；不同题各一条", async () => {
    vi.useFakeTimers();
    const { api, unmount } = renderHook("att-1");
    api.trackInkEdit("q1", "undo");
    api.trackInkEdit("q1", "undo");
    api.trackInkEdit("q1", "erase");
    api.trackInkEdit("q2", "clear");
    // 防抖窗口（2s）与队列周期（5s）均未到：不出网
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(
      (await flushedEvents()).filter((e) => e.type === "ink_edit_batch"),
    ).toHaveLength(0);
    // 越过防抖窗口（编辑入队）与队列 5 秒周期（出网）
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    const batches = (await flushedEvents()).filter(
      (e) => e.type === "ink_edit_batch",
    );
    expect(batches).toEqual([
      {
        type: "ink_edit_batch",
        clientTs: expect.any(Number),
        questionId: "q1",
        erase: 1,
        undo: 2,
        redo: 0,
        clear: 0,
      },
      {
        type: "ink_edit_batch",
        clientTs: expect.any(Number),
        questionId: "q2",
        erase: 0,
        undo: 0,
        redo: 0,
        clear: 1,
      },
    ]);
    unmount();
  });

  it("交卷（finalizeSubmit）把未到期批次冲出（submit 前序列完整）", async () => {
    const { api, unmount } = renderHook("att-1");
    api.trackInkEdit("q1", "redo");
    await act(async () => {
      await api.finalizeSubmit();
    });
    const events = await flushedEvents();
    const batchIndex = events.findIndex((e) => e.type === "ink_edit_batch");
    const submitIndex = events.findIndex((e) => e.type === "submit");
    expect(batchIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(batchIndex);
    unmount();
  });

  it("卸载冲出未到期批次（dispose 尽力 flush）", async () => {
    const { api, unmount } = renderHook("att-1");
    api.trackInkEdit("q1", "erase");
    unmount();
    const events = await flushedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ink_edit_batch",
        questionId: "q1",
        erase: 1,
      }),
    );
  });
});

describe("useAttemptEvents：ink_fullscreen / hint 解锁（T4.0b）", () => {
  it("全屏进出各一条 ink_fullscreen{on}", async () => {
    const { api, unmount } = renderHook("att-1");
    api.trackInkFullscreen("q1", true);
    api.trackInkFullscreen("q1", false);
    await act(async () => {
      await api.finalizeSubmit();
    });
    const events = await flushedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ink_fullscreen",
        questionId: "q1",
        on: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ink_fullscreen",
        questionId: "q1",
        on: false,
      }),
    );
    unmount();
  });

  it("hint 解锁成功报 directive_interact{host:question}，index 用解锁序号", async () => {
    const { api, unmount } = renderHook("att-1");
    api.trackHintUnlock("q3", 0);
    await act(async () => {
      await api.finalizeSubmit();
    });
    const events = await flushedEvents();
    expect(events).toContainEqual({
      type: "directive_interact",
      clientTs: expect.any(Number),
      host: "question",
      questionId: "q3",
      name: "hint",
      index: 0,
      action: "open",
    });
    unmount();
  });
});
