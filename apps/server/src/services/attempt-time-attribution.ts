import type { Segment } from "./question-activity-replay";
export interface OccupiedTimeSpan {
  start: number;
  end: number;
}
export interface AllocatedTimeSpan extends OccupiedTimeSpan {
  questionId: string | null;
  kind: "active" | "observed" | "unattributed";
}
/** 先扣首封存占用，再按一次扫描公平归属本批；旧账回看不传入候选。 */
export function allocateTimeSpans(
  segments: readonly Segment[],
  targets: ReadonlySet<string>,
  occupied: readonly OccupiedTimeSpan[],
): AllocatedTimeSpan[] {
  const points = [
    ...new Set([...segments, ...occupied].flatMap((s) => [s.start, s.end])),
  ].sort((a, b) => a - b);
  const byStart = [...segments].sort((a, b) => a.start - b.start);
  const previous = [...occupied].sort((a, b) => a.start - b.start);
  const live: Segment[] = [];
  const result: AllocatedTimeSpan[] = [];
  let cursor = 0,
    oldCursor = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i] as number,
      end = points[i + 1] as number;
    while (
      cursor < byStart.length &&
      (byStart[cursor] as Segment).start <= start
    )
      live.push(byStart[cursor++] as Segment);
    for (let j = live.length - 1; j >= 0; j--)
      if ((live[j] as Segment).end <= start) live.splice(j, 1);
    while (
      oldCursor < previous.length &&
      (previous[oldCursor] as OccupiedTimeSpan).end <= start
    )
      oldCursor++;
    if (
      previous[oldCursor] &&
      (previous[oldCursor] as OccupiedTimeSpan).start < end
    )
      continue;
    if (!live.some((s) => targets.has(s.questionId))) continue;
    const ids = new Set(live.map((s) => s.questionId));
    const questionId = ids.size === 1 ? (live[0]?.questionId ?? null) : null;
    const kind =
      questionId === null
        ? "unattributed"
        : live.some((s) => s.active)
          ? "active"
          : "observed";
    const last = result.at(-1);
    if (
      last &&
      last.end === start &&
      last.questionId === questionId &&
      last.kind === kind
    )
      last.end = end;
    else result.push({ questionId, kind, start, end });
  }
  return result;
}
