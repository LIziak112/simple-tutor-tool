import { act, render } from "@testing-library/react";
import type { StudentAnswer } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/attempt/AttemptEditorContext";
import {
  bumpNoteBaseRevisionForTest,
  installNoteBackend,
  memoryNoteBackend,
  resetNoteStoreForTest,
  writeNoteDoc,
} from "@/features/notes/note-store";
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
it("父级保存状态更新时事件操作对象保持稳定，题卡不会因此重渲染", () => {
  let current: ReturnType<typeof useAttemptEvents> | undefined;
  function Probe() {
    current = useAttemptEvents("stable-events");
    return null;
  }
  const { rerender } = render(<Probe />);
  const before = current;
  rerender(<Probe />);
  expect(current).toBe(before);
});

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

// ---------- 2026-10-28 使用数据补缺（hall-15077）：editor_toggle / note_sync ----------

describe("useAttemptEvents：编辑器开合 / 草稿同步（2026-10-28 使用数据补缺）", () => {
  beforeEach(() => {
    installNoteBackend(memoryNoteBackend());
    resetNoteStoreForTest();
  });
  afterEach(() => {
    resetNoteStoreForTest();
  });

  /** 编辑器协调器 Provider 下的探针：同时拿埋点 API 与全局编辑器态
   *  （经 holder 属性访问，避开 TS 对「仅闭包内赋值」变量的过紧收窄） */
  function renderWithEditor(attemptId: string) {
    const holder: {
      api: ReturnType<typeof useAttemptEvents> | null;
      editor: ReturnType<typeof useAttemptEditor> | null;
    } = { api: null, editor: null };
    function Probe() {
      holder.api = useAttemptEvents(attemptId);
      holder.editor = useAttemptEditor(undefined);
      return null;
    }
    const { unmount } = render(
      <AttemptEditorProvider>
        <Probe />
      </AttemptEditorProvider>,
    );
    if (holder.api === null || holder.editor === null) {
      throw new Error("Probe 未渲染");
    }
    const { api, editor } = holder;
    return { api, editor, unmount };
  }

  it("编辑器激活/退出报 editor_toggle；切换产生一关一开，成对可读", async () => {
    const { editor, unmount } = renderWithEditor("att-1");
    await act(async () => {
      await editor.request({ questionId: "q1", kind: "scratch" });
    });
    await act(async () => {
      await editor.request({ questionId: "q2", kind: "annotation" });
    });
    await act(async () => {
      await editor.request(null);
    });
    unmount();
    const toggles = (await flushedEvents()).filter(
      (e) => e.type === "editor_toggle",
    );
    expect(toggles).toEqual([
      {
        type: "editor_toggle",
        clientTs: expect.any(Number),
        questionId: "q1",
        editor: "scratch",
        on: true,
      },
      {
        type: "editor_toggle",
        clientTs: expect.any(Number),
        questionId: "q1",
        editor: "scratch",
        on: false,
      },
      {
        type: "editor_toggle",
        clientTs: expect.any(Number),
        questionId: "q2",
        editor: "annotation",
        on: true,
      },
      {
        type: "editor_toggle",
        clientTs: expect.any(Number),
        questionId: "q2",
        editor: "annotation",
        on: false,
      },
    ]);
  });

  it("note_sync：首次观察只记基线；baseRevision 前进报一条；同版本不重报", async () => {
    const session = { origin: "http://test", studentId: "stu-1" };
    const scope = {
      attemptId: "att-1",
      questionId: "q1",
      phase: "scratch" as const,
    };
    const { unmount } = renderHook("att-1");
    writeNoteDoc(session, scope, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [0, 1].map((i) => ({
          tool: "pen" as const,
          color: "#000000",
          weight: 4,
          points: [{ x: i, y: i, p: 0.5, t: i }],
        })),
      },
    });
    bumpNoteBaseRevisionForTest(session, scope, 1); // 首次观察 ≥1：只记基线
    bumpNoteBaseRevisionForTest(session, scope, 2); // 前进：报一条
    bumpNoteBaseRevisionForTest(session, scope, 2); // 同版本：不重报
    // 他题（attempt 不匹配）不报
    bumpNoteBaseRevisionForTest(
      session,
      { attemptId: "att-other", questionId: "q9", phase: "scratch" },
      5,
    );
    unmount();
    const syncs = (await flushedEvents()).filter((e) => e.type === "note_sync");
    expect(syncs).toEqual([
      {
        type: "note_sync",
        clientTs: expect.any(Number),
        questionId: "q1",
        phase: "scratch",
        revision: 2,
        strokes: 2,
      },
    ]);
  });
});
