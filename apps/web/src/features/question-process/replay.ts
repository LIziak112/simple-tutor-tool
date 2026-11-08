import type {
  QuestionProcessEvent,
  QuestionProcessLayer,
  QuestionProcessSurface,
  StudentAnswer,
} from "@tutor/contract";
import {
  normalizePointTimes,
  REPLAY_PAUSE_CAP_MS,
} from "@/features/ink/replay/model";

export function replayPrefix(events: readonly QuestionProcessEvent[]) {
  const end = events.findIndex(
    (event, i) =>
      event.seq !== i ||
      (event.kind === "start") !== (i === 0) ||
      event.at < (events[i - 1]?.at ?? 0),
  );
  return { events: end < 0 ? events : events.slice(0, end), gap: end >= 0 };
}

export interface QuestionProcessFrame {
  visiblePoints: Partial<Record<QuestionProcessLayer, number[]>>;
  answer: StudentAnswer | null;
  hints: number[];
  layers: Partial<
    Record<QuestionProcessLayer, QuestionProcessSurface | undefined>
  >;
}

export function frameAt(
  events: readonly QuestionProcessEvent[],
  at: number,
  throughSeq = Number.POSITIVE_INFINITY,
  segmentStartedAt?: number,
): QuestionProcessFrame | null {
  events = replayPrefix(events).events;
  const first = events[0];
  if (first?.kind !== "start" || first.seq !== 0 || at < first.at) return null;
  const state: QuestionProcessFrame = {
    visiblePoints: {},
    answer: first.answer,
    hints: [...first.hints],
    layers: { ...first.layers },
  };
  for (let i = 1; i < events.length; i += 1) {
    const event = events[i];
    if (!event || event.seq !== i || event.at > at || event.seq > throughSeq)
      break;
    switch (event.kind) {
      case "surface":
        state.layers[event.layer] = event.surface;
        break;
      case "ink": {
        const previous = state.layers[event.layer];
        const removed = new Set(event.removed);
        const strokes =
          previous?.strokes.filter((stroke) => !removed.has(stroke.id)) ?? [];
        for (const { index, stroke } of event.added)
          strokes.splice(index, 0, stroke);
        state.layers[event.layer] = {
          width: 1000,
          height: 800,
          ...(event.frame ?? previous),
          strokes,
        };
        break;
      }
      case "answer":
        state.answer = event.answer;
        break;
      case "hint":
        if (event.action === "shown" && !state.hints.includes(event.index)) {
          state.hints.push(event.index);
        }
        break;
    }
  }
  for (const [layer, surface] of Object.entries(state.layers)) {
    state.visiblePoints[layer as QuestionProcessLayer] =
      surface?.strokes.map((stroke) => stroke.points.length) ?? [];
  }
  if (Number.isFinite(at)) {
    for (const event of events) {
      if (event.seq > throughSeq) break;
      if (
        event.kind !== "ink" ||
        event.operation !== "stroke" ||
        event.at <= at
      )
        continue;
      for (const { index, stroke } of event.added) {
        const rawTimes = stroke.points.map((point) =>
          Number.isFinite(point.t) ? point.t : null,
        );
        const hasTiming = rawTimes.some((t) => t !== null && t > 0);
        const times = normalizePointTimes(
          hasTiming ? rawTimes : rawTimes.map(() => null),
        );
        const duration = times.at(-1) ?? 0;
        const absolute =
          hasTiming &&
          segmentStartedAt !== undefined &&
          stroke.startedAt !== undefined
            ? stroke.startedAt - segmentStartedAt
            : undefined;
        const startMs =
          absolute !== undefined && absolute <= event.at
            ? absolute
            : event.at - duration;
        if (at < startMs) continue;
        const previous = state.layers[event.layer];
        const strokes = [...(previous?.strokes ?? [])];
        const counts = [...(state.visiblePoints[event.layer] ?? [])];
        strokes.splice(index, 0, stroke);
        counts.splice(index, 0, times.filter((t) => t <= at - startMs).length);
        state.layers[event.layer] = {
          width: 1000,
          height: 800,
          ...(event.frame ?? previous),
          strokes,
        };
        state.visiblePoints[event.layer] = counts;
      }
    }
  }
  return state;
}

export interface ProcessPause {
  startMs: number;
  endMs: number;
  realMs: number;
}

export function processPauses(
  events: readonly { at: number }[],
): ProcessPause[] {
  return events.flatMap((event, i) => {
    const previous = events[i - 1];
    const realMs = event.at - (previous?.at ?? event.at);
    return previous && realMs > REPLAY_PAUSE_CAP_MS
      ? [{ startMs: previous.at, endMs: event.at, realMs }]
      : [];
  });
}

export function toPlaybackTime(
  realMs: number,
  pauses: readonly ProcessPause[],
) {
  return pauses.reduce(
    (time, pause) =>
      time -
      Math.max(0, Math.min(realMs, pause.endMs) - pause.startMs) *
        (1 - REPLAY_PAUSE_CAP_MS / pause.realMs),
    realMs,
  );
}

export function fromPlaybackTime(
  timeMs: number,
  pauses: readonly ProcessPause[],
) {
  let removed = 0;
  for (const pause of pauses) {
    const start = pause.startMs - removed;
    if (timeMs < start) break;
    if (timeMs <= start + REPLAY_PAUSE_CAP_MS)
      return (
        pause.startMs + ((timeMs - start) * pause.realMs) / REPLAY_PAUSE_CAP_MS
      );
    removed += pause.realMs - REPLAY_PAUSE_CAP_MS;
  }
  return timeMs + removed;
}

type ProcessSegment =
  import("@tutor/contract").QuestionProcessRead["segments"][number];
export function questionTimeline(input: readonly ProcessSegment[]) {
  const ordered = [...input].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  );
  const origin = ordered[0]?.startedAt ?? 0;
  let previousEnd = 0;
  const segments = ordered.filter(
    (segment) =>
      segment.events[0]?.kind === "start" && segment.events[0].seq === 0,
  );
  const events = ordered
    .flatMap((segment, segmentIndex) => {
      const offset = segment.startedAt - origin;
      const gapMs = Math.max(0, offset - previousEnd);
      const overlap = segmentIndex > 0 && offset < previousEnd;
      previousEnd = Math.max(
        previousEnd,
        offset + (segment.events.at(-1)?.at ?? 0),
      );
      return replayPrefix(segment.events).events.map((event) => ({
        event,
        segment,
        segmentIndex,
        at: offset + event.at,
        gapMs,
        overlap,
      }));
    })
    .sort(
      (a, b) =>
        a.at - b.at ||
        a.segmentIndex - b.segmentIndex ||
        a.event.seq - b.event.seq,
    );
  return { origin, segments, events };
}

export function timelineFrame(
  timeline: ReturnType<typeof questionTimeline>,
  at: number,
  selected?: number,
) {
  const entry = selected === undefined ? undefined : timeline.events[selected];
  const segment =
    entry?.segment ??
    timeline.segments.findLast(
      (segment) =>
        segment.startedAt - timeline.origin + (segment.events[0]?.at ?? 0) <=
        at,
    );
  if (!segment) return null;
  return frameAt(
    segment.events,
    entry ? Infinity : at - (segment.startedAt - timeline.origin),
    entry?.event.seq ?? Infinity,
    segment.startedAt,
  );
}
