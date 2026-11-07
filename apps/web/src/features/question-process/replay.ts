import type {
  QuestionProcessEvent,
  QuestionProcessLayer,
  QuestionProcessSurface,
  StudentAnswer,
} from "@tutor/contract";

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
): QuestionProcessFrame | null {
  const first = events[0];
  if (first?.kind !== "start" || first.seq !== 0 || at < first.at) return null;
  const state: QuestionProcessFrame = {
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
  return state;
}
