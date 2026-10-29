import type { TeacherAttemptReplayData } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { replayStateAt, replayWindow } from "./replay-model";

/** replay-model 单测（hall-15077）：窗口、事件重放、服务端事实钳制、前向兼容 */
const T0 = 1_700_000_000_000;

function base(
  overrides: Partial<TeacherAttemptReplayData> = {},
): TeacherAttemptReplayData {
  return {
    attemptId: "0b5d3c2a-0000-4000-8000-000000000001",
    submittedAt: null,
    windowStartMs: T0,
    windowEndMs: T0 + 60_000,
    events: [],
    noteVersions: [],
    inkPoints: [],
    submitPoints: [],
    ...overrides,
  };
}

describe("replayWindow", () => {
  it("空数据无窗口", () => {
    expect(
      replayWindow(base({ windowStartMs: null, windowEndMs: null })),
    ).toBeNull();
  });

  it("有窗口原样返回", () => {
    expect(replayWindow(base())).toEqual({ startMs: T0, endMs: T0 + 60_000 });
  });
});

describe("replayStateAt", () => {
  it("事件驱动：focus/blur、answer_change、hint、ink batch", () => {
    const data = base({
      events: [
        {
          type: "attempt_start",
          clientTs: T0,
          serverTs: "2026-10-29T00:00:00Z",
          questionId: null,
          payload: {},
        },
        {
          type: "question_focus",
          clientTs: T0 + 1_000,
          serverTs: "2026-10-29T00:00:01Z",
          questionId: "q1",
          payload: {},
        },
        {
          type: "answer_change",
          clientTs: T0 + 2_000,
          serverTs: "2026-10-29T00:00:02Z",
          questionId: "q1",
          payload: { from: null, to: "A" },
        },
        {
          type: "answer_change",
          clientTs: T0 + 3_000,
          serverTs: "2026-10-29T00:00:03Z",
          questionId: "q1",
          payload: { to: "B" },
        },
        {
          type: "hint_open",
          clientTs: T0 + 4_000,
          serverTs: "2026-10-29T00:00:04Z",
          questionId: "q1",
          payload: { index: 0 },
        },
        {
          type: "ink_stroke_batch",
          clientTs: T0 + 5_000,
          serverTs: "2026-10-29T00:00:05Z",
          questionId: "q2",
          payload: { strokes: 3 },
        },
        {
          type: "question_blur",
          clientTs: T0 + 6_000,
          serverTs: "2026-10-29T00:00:06Z",
          questionId: "q1",
          payload: {},
        },
      ],
    });
    const mid = replayStateAt(data, T0 + 5_000);
    expect(mid).not.toBeNull();
    const q1 = mid?.questions.get("q1");
    expect(q1?.answerChanges).toBe(2);
    expect(q1?.lastAnswer).toBe("B");
    expect(q1?.hintsOpened).toBe(1);
    expect(mid?.focusQuestionId).toBe("q1");
    const q2 = mid?.questions.get("q2");
    expect(q2?.strokes).toBe(3);

    const end = replayStateAt(data, T0 + 60_000);
    expect(end?.focusQuestionId).toBeNull();
    expect(end?.consumedEvents).toBe(7);
  });

  it("全局三态：page_hidden/visible、net、idle", () => {
    const data = base({
      events: [
        {
          type: "page_hidden",
          clientTs: T0 + 1_000,
          serverTs: "2026-10-29T00:00:01Z",
          questionId: null,
          payload: {},
        },
        {
          type: "net_offline",
          clientTs: T0 + 2_000,
          serverTs: "2026-10-29T00:00:02Z",
          questionId: null,
          payload: {},
        },
        {
          type: "idle_start",
          clientTs: T0 + 3_000,
          serverTs: "2026-10-29T00:00:03Z",
          questionId: null,
          payload: {},
        },
        {
          type: "page_visible",
          clientTs: T0 + 8_000,
          serverTs: "2026-10-29T00:00:08Z",
          questionId: null,
          payload: {},
        },
        {
          type: "idle_end",
          clientTs: T0 + 9_000,
          serverTs: "2026-10-29T00:00:09Z",
          questionId: null,
          payload: {},
        },
        {
          type: "net_online",
          clientTs: T0 + 10_000,
          serverTs: "2026-10-29T00:00:10Z",
          questionId: null,
          payload: {},
        },
      ],
    });
    const at5 = replayStateAt(data, T0 + 5_000);
    expect(at5?.pageHidden).toBe(true);
    expect(at5?.offline).toBe(true);
    expect(at5?.idle).toBe(true);
    const atEnd = replayStateAt(data, T0 + 60_000);
    expect(atEnd?.pageHidden).toBe(false);
    expect(atEnd?.offline).toBe(false);
    expect(atEnd?.idle).toBe(false);
  });

  it("服务端事实按 ISO 换算并钳制：早于窗口在起点成立，晚于终点在终点成立", () => {
    const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
    const data = base({
      noteVersions: [
        {
          questionId: "q1",
          revision: 1,
          savedAt: iso(-5_000),
          phase: "scratch",
        },
        {
          questionId: "q1",
          revision: 2,
          savedAt: iso(10_000),
          phase: "scratch",
        },
      ],
      inkPoints: [
        {
          questionId: "q2",
          updatedAt: iso(70_000),
          strokeCount: 4,
          revision: 1,
        },
      ],
      submitPoints: [{ questionId: "q1", submittedAt: iso(20_000) }],
    });
    const atStart = replayStateAt(data, T0);
    expect(atStart?.questions.get("q1")?.draftRevision).toBe(1);
    const at15 = replayStateAt(data, T0 + 15_000);
    expect(at15?.questions.get("q1")?.draftRevision).toBe(2);
    expect(at15?.questions.get("q1")?.submittedAtMs).toBeNull();
    const atEnd = replayStateAt(data, T0 + 60_000);
    expect(atEnd?.questions.get("q2")?.strokes).toBe(0);
    expect(atEnd?.questions.get("q1")?.submittedAtMs).toBe(T0 + 20_000);
  });

  it("未知事件类型忽略不报错；t 越界按窗口端点钳制", () => {
    const data = base({
      events: [
        {
          type: "future_thing",
          clientTs: T0 + 1_000,
          serverTs: "2026-10-29T00:00:01Z",
          questionId: "q1",
          payload: { x: 1 },
        },
        {
          type: "question_focus",
          clientTs: T0 + 2_000,
          serverTs: "2026-10-29T00:00:02Z",
          questionId: "q1",
          payload: {},
        },
      ],
    });
    const early = replayStateAt(data, T0 - 99_999);
    expect(early?.tMs).toBe(T0);
    expect(early?.consumedEvents).toBe(0);
    const state = replayStateAt(data, T0 + 60_000);
    expect(state?.focusQuestionId).toBe("q1");
    expect(state?.consumedEvents).toBe(2);
  });

  it("新采集事件（note_sync / editor_toggle）进时间轴时按未知类型忽略不炸", () => {
    const data = base({
      events: [
        {
          type: "note_sync",
          clientTs: T0 + 1_000,
          serverTs: "2026-10-29T00:00:01Z",
          questionId: "q1",
          payload: { revision: 2 },
        },
        {
          type: "editor_toggle",
          clientTs: T0 + 2_000,
          serverTs: "2026-10-29T00:00:02Z",
          questionId: "q1",
          payload: { on: true },
        },
        {
          type: "question_focus",
          clientTs: T0 + 3_000,
          serverTs: "2026-10-29T00:00:03Z",
          questionId: "q1",
          payload: {},
        },
      ],
    });
    const state = replayStateAt(data, T0 + 60_000);
    expect(state?.consumedEvents).toBe(3);
    expect(state?.focusQuestionId).toBe("q1");
  });
});
