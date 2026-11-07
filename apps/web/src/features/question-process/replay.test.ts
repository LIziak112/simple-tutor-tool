import type { QuestionProcessEvent } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  frameAt,
  fromPlaybackTime,
  processPauses,
  questionTimeline,
  replayPrefix,
  timelineFrame,
  toPlaybackTime,
} from "./replay";

const stroke = {
  id: "stroke-a",
  tool: "pen" as const,
  color: "#000",
  weight: 2,
  points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
};

const events = [
  { seq: 0, at: 0, kind: "start", answer: null, hints: [], layers: {} },
  {
    seq: 1,
    at: 10,
    kind: "ink",
    layer: "annotation",
    operation: "stroke",
    removed: [],
    added: [{ index: 0, stroke }],
  },
  { seq: 2, at: 20, kind: "answer", answer: { kind: "choice", index: 0 } },
  {
    seq: 3,
    at: 30,
    kind: "ink",
    layer: "scratch",
    operation: "stroke",
    removed: [],
    added: [{ index: 0, stroke }],
  },
  {
    seq: 4,
    at: 40,
    kind: "ink",
    layer: "scratch",
    operation: "erase",
    removed: [stroke.id],
    added: [],
  },
  {
    seq: 5,
    at: 50,
    kind: "ink",
    layer: "scratch",
    operation: "undo",
    removed: [],
    added: [{ index: 0, stroke }],
  },
  {
    seq: 6,
    at: 60,
    kind: "hint",
    action: "received",
    requestId: "hint-request",
    index: 0,
  },
  {
    seq: 7,
    at: 70,
    kind: "hint",
    action: "shown",
    requestId: "hint-request",
    index: 0,
  },
  { seq: 8, at: 70, kind: "answer", answer: { kind: "choice", index: 2 } },
] satisfies QuestionProcessEvent[];

describe("单题过程回放", () => {
  it("按同一时间轴应用两层笔迹、答题值和实际呈现的提示", () => {
    expect(frameAt(events, 29)?.answer).toEqual({ kind: "choice", index: 0 });
    expect(frameAt(events, 40)?.layers.scratch?.strokes).toEqual([]);
    expect(frameAt(events, 40)?.layers.annotation?.strokes).toEqual([stroke]);
    expect(frameAt(events, 60)?.layers.scratch?.strokes).toEqual([stroke]);
    expect(frameAt(events, 60)?.hints).toEqual([]);
    expect(frameAt(events, 70)?.hints).toEqual([0]);
    expect(frameAt(events, 70)?.answer).toEqual({ kind: "choice", index: 2 });
    expect(frameAt(events, 30)?.layers.scratch?.strokes).toEqual([stroke]);
  });

  it("书写中的笔画逐点出现，点节点仍显示完整状态", () => {
    const timed = [
      { seq: 0, at: 0, kind: "start", answer: null, hints: [], layers: {} },
      {
        seq: 1,
        kind: "ink",
        layer: "annotation",
        operation: "stroke",
        removed: [],
        at: 1000,
        added: [
          {
            index: 0,
            stroke: {
              ...stroke,
              points: [0, 100, 200].map((t) => ({ x: t, y: 30, p: 0.5, t })),
            },
          },
        ],
      },
    ] satisfies QuestionProcessEvent[];
    expect(frameAt(timed, 799)?.layers.annotation?.strokes ?? []).toHaveLength(
      0,
    );
    expect(frameAt(timed, 900)?.visiblePoints.annotation).toEqual([2]);
    expect(frameAt(timed, 1000)?.visiblePoints.annotation).toEqual([3]);
    expect(frameAt(timed, Infinity, 1)?.visiblePoints.annotation).toEqual([3]);
    expect(frameAt(timed, Infinity, 0)?.layers.annotation).toBeUndefined();
  });

  it("旧笔画的零时长采样匀速退化，缺段之后的笔画不提前显示", () => {
    const start: QuestionProcessEvent = {
      seq: 0,
      at: 0,
      kind: "start",
      answer: null,
      hints: [],
      layers: {},
    };
    const ink: QuestionProcessEvent = {
      seq: 1,
      at: 1000,
      kind: "ink",
      layer: "scratch",
      operation: "stroke",
      removed: [],
      added: [
        {
          index: 0,
          stroke: {
            ...stroke,
            points: Array.from({ length: 3 }, (_, x) => ({
              x,
              y: 0,
              t: 0,
              p: 0.5,
            })),
          },
        },
      ],
    };
    expect(frameAt([start, ink], 988)?.visiblePoints.scratch).toEqual([2]);
    expect(
      frameAt([start, { ...ink, seq: 2 }], 988)?.layers.scratch,
    ).toBeUndefined();
  });

  it("长停顿压成5秒且可逆，真实时间模式保留完整时长", () => {
    const pauses = processPauses([
      { at: 0 },
      { at: 1000 },
      { at: 21000 },
      { at: 22000 },
    ]);
    expect(pauses).toEqual([{ startMs: 1000, endMs: 21000, realMs: 20000 }]);
    expect(toPlaybackTime(22000, pauses)).toBe(7000);
    expect(toPlaybackTime(11000, pauses)).toBe(3500);
    expect(fromPlaybackTime(3500, pauses)).toBe(11000);
    expect(fromPlaybackTime(7000, pauses)).toBe(22000);
    expect(toPlaybackTime(22000, [])).toBe(22000);
    expect(fromPlaybackTime(22000, [])).toBe(22000);
    expect(processPauses([{ at: 0 }, { at: 5000 }])).toEqual([]);
  });

  it("多段按开始时刻串接，跨刷新切换快照且不沿用上一段提示", () => {
    const first = {
      id: "first",
      startedAt: 1000,
      gap: false,
      events: [
        {
          seq: 0,
          at: 0,
          kind: "start",
          answer: null,
          hints: [0],
          layers: { scratch: { width: 1000, height: 800, strokes: [stroke] } },
        },
        {
          seq: 1,
          at: 1000,
          kind: "answer",
          answer: { kind: "choice", index: 1 },
        },
      ],
    } satisfies import("@tutor/contract").QuestionProcessRead["segments"][number];
    const second = {
      id: "second",
      startedAt: 5000,
      gap: false,
      events: [
        {
          seq: 0,
          at: 0,
          kind: "start",
          answer: { kind: "choice", index: 2 },
          hints: [],
          layers: {},
        },
      ],
    } satisfies import("@tutor/contract").QuestionProcessRead["segments"][number];
    const third = { ...second, id: "third", startedAt: 9000 };
    const timeline = questionTimeline([third, first, second]);
    expect(timeline.events.map((entry) => entry.at)).toEqual([
      0, 1000, 4000, 8000,
    ]);
    expect(
      timeline.events
        .filter(
          (entry) => entry.event.kind === "start" && entry.segmentIndex > 0,
        )
        .map((entry) => entry.gapMs),
    ).toEqual([3000, 4000]);
    expect(timelineFrame(timeline, 3999)?.answer).toEqual({
      kind: "choice",
      index: 1,
    });
    expect(timelineFrame(timeline, 4000)?.answer).toEqual({
      kind: "choice",
      index: 2,
    });
    expect(timelineFrame(timeline, 4000)?.layers.scratch).toBeUndefined();
    expect(timelineFrame(timeline, 4000)?.hints).toEqual([]);
    expect(timelineFrame(timeline, 8000, 1)?.answer).toEqual({
      kind: "choice",
      index: 1,
    });
  });

  it("空缺段不阻塞后续可播放段，重叠段给出明确标记", () => {
    const start: QuestionProcessEvent = {
      seq: 0,
      at: 0,
      kind: "start",
      answer: null,
      hints: [],
      layers: {},
    };
    const timeline = questionTimeline([
      { id: "missing", startedAt: 1000, events: [], gap: true },
      {
        id: "one",
        startedAt: 2000,
        events: [
          start,
          { seq: 1, at: 2000, kind: "boundary", reason: "closed" },
        ],
        gap: false,
      },
      { id: "two", startedAt: 3000, events: [start], gap: false },
    ]);
    expect(timelineFrame(timeline, 1000)?.answer).toBeNull();
    expect(timeline.segments.map((segment) => segment.id)).toEqual([
      "one",
      "two",
    ]);
    expect(
      timeline.events.find((entry) => entry.segment.id === "two")?.overlap,
    ).toBe(true);
  });

  it("缺段时停在可验证的前缀，后续快照不冒充连续历史", () => {
    expect(replayPrefix(events.filter((event) => event.seq !== 4))).toEqual({
      events: events.slice(0, 4),
      gap: true,
    });
    expect(frameAt(events.slice(1), 70)).toBeNull();
  });
});
