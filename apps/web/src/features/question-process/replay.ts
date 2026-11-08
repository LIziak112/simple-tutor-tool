import type {
  QuestionProcessEvent,
  QuestionProcessLayer,
  QuestionProcessSurface,
  StudentAnswer,
} from "@tutor/contract";
import { normalizePointTimes } from "@/features/ink/replay/model";

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
