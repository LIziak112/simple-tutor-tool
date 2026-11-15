import type { StudentAnswer } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "@/features/answering/AttemptEditorContext";
import {
  bumpNoteBaseRevisionForTest,
  installNoteBackend,
  memoryNoteBackend,
  resetNoteStoreForTest,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { QuestionProcessRecorder } from "@/features/question-process/recorder";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import { memoryKVBackend } from "@/lib/kv-backend";
import { act, render } from "@/test/render-with-portal";
import {
  resumeFocusAfterFailedSubmit,
  settleEventsBeforeSubmit,
} from "./submit-event-settle";
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
  settleQuestionSubmit(questionIds: readonly string[]): Promise<void>;
  resumeQuestionFocus(): void;
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
    expect(submitIndex).toBe(-1);
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

// ---------- 题级提交前收口：服务端提交时封存用时，只算已收到的事件 ----------

describe("useAttemptEvents：题级提交前收口（逐题 / 讲练单题 / 分批）", () => {
  /** 已出网事件里与聚焦有关的那几种，按出网顺序 */
  const focusTrail = (events: PostedEvent[]) =>
    events
      .filter((e) =>
        ["question_focus", "question_blur", "answer_change"].includes(
          String(e.type),
        ),
      )
      .map((e) => `${String(e.type)}:${String(e.questionId)}`);

  it("聚焦题在这批里：结束它的聚焦，返回前事件已经出网", async () => {
    const { api, unmount } = renderHook("att-settle-1");
    api.noteInteraction("q1");
    api.trackAnswerChange("q1", { kind: "judge", value: true });
    api.trackInkEdit("q1", "undo");
    expect(mockedPost).not.toHaveBeenCalled();

    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    // 不等 5 秒定时器：settleQuestionSubmit 返回时这一批已经发出
    const events = mockedPost.mock.calls.flatMap(
      (call) => call[1] as unknown as PostedEvent[],
    );
    expect(focusTrail(events)).toEqual([
      "question_focus:q1",
      "answer_change:q1",
      "question_blur:q1",
    ]);
    // 未到期的手写编辑批次一并冲出
    expect(events).toContainEqual(
      expect.objectContaining({ type: "ink_edit_batch", questionId: "q1" }),
    );
    unmount();
    // 聚焦已经结束：卸载不再补第二条 blur
    expect(
      focusTrail(await flushedEvents()).filter(
        (item) => item === "question_blur:q1",
      ),
    ).toHaveLength(1);
  });

  it("聚焦题不在这批里：它的聚焦不动，事件照样出网", async () => {
    const { api, unmount } = renderHook("att-settle-2");
    api.noteInteraction("q2");
    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    expect(focusTrail(await flushedEvents())).toEqual(["question_focus:q2"]);
    // q2 仍是聚焦题：再交互不重复报 focus，切题时才补它的 blur
    api.noteInteraction("q2");
    api.noteInteraction("q3");
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q2",
      "question_blur:q2",
      "question_focus:q3",
      "question_blur:q3",
    ]);
    unmount();
  });

  it("提交成了：之后再在这道题上交互，照常重新聚焦", async () => {
    const { api, unmount } = renderHook("att-settle-3");
    api.noteInteraction("q1");
    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    api.noteInteraction("q1");
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q1",
      "question_blur:q1",
      "question_focus:q1",
      "question_blur:q1",
    ]);
    unmount();
  });

  it("提交没成：resumeQuestionFocus 把聚焦接回同一道题，只接一次", async () => {
    const { api, unmount } = renderHook("att-settle-4");
    api.noteInteraction("q1");
    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    api.resumeQuestionFocus();
    api.resumeQuestionFocus();
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q1",
      "question_blur:q1",
      "question_focus:q1",
      "question_blur:q1",
    ]);
    unmount();
  });

  it("提交没成但学生已经去了别的题：不把聚焦抢回来", async () => {
    const { api, unmount } = renderHook("att-settle-5");
    api.noteInteraction("q1");
    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    api.noteInteraction("q2");
    api.resumeQuestionFocus();
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q1",
      "question_blur:q1",
      "question_focus:q2",
      "question_blur:q2",
    ]);
    unmount();
  });

  it("没有结束过聚焦（聚焦题不在批里）：resumeQuestionFocus 什么都不做", async () => {
    const { api, unmount } = renderHook("att-settle-6");
    api.noteInteraction("q2");
    await act(async () => {
      await api.settleQuestionSubmit(["q1"]);
    });
    api.resumeQuestionFocus();
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q2",
      "question_blur:q2",
    ]);
    unmount();
  });

  it("按卷登记：各提交路径经 submit-event-settle 调到本卷的收口；卸载后撤销", async () => {
    const { api, unmount } = renderHook("att-settle-7");
    api.noteInteraction("q1");
    await act(async () => {
      await settleEventsBeforeSubmit("att-settle-7", ["q1"]);
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q1",
      "question_blur:q1",
    ]);
    // 提交没成 → 经登记表接回聚焦
    resumeFocusAfterFailedSubmit("att-settle-7");
    // 别的卷号调不到这里
    await act(async () => {
      await settleEventsBeforeSubmit("att-other", ["q1"]);
    });
    await act(async () => {
      await api.finalizeSubmit();
    });
    expect(focusTrail(await flushedEvents())).toEqual([
      "question_focus:q1",
      "question_blur:q1",
      "question_focus:q1",
      "question_blur:q1",
    ]);
    unmount();
    mockedPost.mockClear();
    await act(async () => {
      await settleEventsBeforeSubmit("att-settle-7", ["q1"]);
    });
    resumeFocusAfterFailedSubmit("att-settle-7");
    expect(mockedPost).not.toHaveBeenCalled();
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

  it("editor_toggle 走命令式订阅：埋点宿主组件不因编辑器开合重渲染（暖开尾部尖峰回归锁）", async () => {
    const holder: {
      renders: number;
      editor: ReturnType<typeof useAttemptEditor> | null;
    } = { renders: 0, editor: null };
    function Probe() {
      holder.renders += 1;
      useAttemptEvents("att-1");
      return null;
    }
    function Driver() {
      holder.editor = useAttemptEditor(undefined);
      return null;
    }
    const { unmount } = render(
      <AttemptEditorProvider>
        <Probe />
        <Driver />
      </AttemptEditorProvider>,
    );
    const editor = holder.editor;
    if (editor === null) throw new Error("Driver 未渲染");
    const renderCount = holder.renders;
    await act(async () => {
      await editor.request({ questionId: "q1", kind: "scratch" });
    });
    await act(async () => {
      await editor.request(null);
    });
    // 编辑器 store 已 publish 两次（开/关），埋点走命令式订阅——埋点宿主不重渲染
    expect(holder.renders).toBe(renderCount);
    unmount();
  });

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

it("原聚焦、纸面开合、全屏、交卷触发点同步进入单题过程", async () => {
  const uploads: import("@tutor/contract").QuestionProcessBatch[] = [];
  const recorder = new QuestionProcessRecorder({
    attemptId: "process-activity",
    recordingId: "863de11a-f212-46e1-b876-d3a29e07df55",
    expiresAt: "2099-01-01T00:00:00.000Z",
    prefix: "activity",
    store: memoryKVBackend(),
    revision: () => "revision",
    current: () => true,
    snapshot: () => ({ answer: null, hints: [], layers: {} }),
    upload: async (batch) => {
      uploads.push(batch);
      return batch.events.at(-1)?.seq ?? -1;
    },
  });
  const ref = { current: recorder };
  const holder: { api: ReturnType<typeof useAttemptEvents> | null } = {
    api: null,
  };
  function Probe() {
    holder.api = useAttemptEvents("process-activity", ref);
    return null;
  }
  let editor: ReturnType<typeof useAttemptEditor> | null = null;
  function Driver() {
    editor = useAttemptEditor(undefined);
    return null;
  }
  const view = render(
    <AttemptEditorProvider>
      <Probe />
      <Driver />
    </AttemptEditorProvider>,
  );
  const api = holder.api;
  if (!api) throw new Error("测试宿主未挂载");
  act(() => {
    api.registerCard("q1", document.createElement("li"));
    api.noteInteraction("q1");
    api.trackInkFullscreen("q1", true);
  });
  await act(async () => {
    if (!editor) throw new Error("编辑器未挂载");
    await editor.requestPaper({ questionId: "q1", kind: "scratch" });
    await editor.requestPaper(null);
    await api.finalizeSubmit();
    api.confirmSubmit();
  });
  await recorder.flush();
  expect(
    uploads
      .flatMap((batch) => batch.events)
      .filter((event) => event.kind === "activity")
      .map((event) => event.action),
  ).toEqual([
    "focus",
    "fullscreen_on",
    "paper_open",
    "paper_close",
    "blur",
    "submit",
  ]);
  view.unmount();
  await recorder.close();
});
