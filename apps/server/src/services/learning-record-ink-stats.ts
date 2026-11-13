import {
  INK_PAUSE_THRESHOLD_MS,
  type InkDeletedStroke,
  type InkMaterialFacet,
  type InkStroke,
} from "@tutor/contract";

// ---------- 过程统计（§3.5 stats；停顿是派生值，不落盘） ----------

interface StrokeTiming {
  id: string | undefined;
  startedAt: number | undefined;
  endMs: number;
}

export function strokeTimings(strokes: readonly InkStroke[]): StrokeTiming[] {
  return strokes.map((stroke) => ({
    id: stroke.id,
    startedAt: stroke.startedAt,
    endMs: (stroke.startedAt ?? 0) + (stroke.points.at(-1)?.t ?? 0),
  }));
}

export function inkStatsOf(
  strokes: readonly InkStroke[],
  deleted: readonly InkDeletedStroke[],
): InkMaterialFacet["stats"] {
  const timings = strokeTimings(strokes);
  const timed = strokes.filter((stroke) => stroke.startedAt !== undefined);
  const writingMs =
    timings.length === 0
      ? null
      : timings.reduce(
          (sum, timing) => sum + (timing.endMs - (timing.startedAt ?? 0)),
          0,
        );
  // 停顿：前一笔收笔到下一笔落笔的间隙 ≥ 阈值；无 id 的旧稿笔画无法被
  // afterStrokeId 引用，如实跳过（不伪造锚）
  const ordered = [...timings].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  const pauses: InkMaterialFacet["stats"]["pauses"] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (prev === undefined || next === undefined) continue;
    if (prev.startedAt === undefined || next.startedAt === undefined) continue;
    if (prev.id === undefined) continue;
    const gap = next.startedAt - prev.endMs;
    if (gap >= INK_PAUSE_THRESHOLD_MS) {
      pauses.push({ afterStrokeId: prev.id, ms: gap });
    }
  }
  const firstAt =
    ordered.find((timing) => timing.startedAt !== undefined)?.startedAt ?? null;
  const lastAt =
    [...ordered].reverse().find((timing) => timing.startedAt !== undefined)
      ?.startedAt ?? null;
  return {
    strokeCount: strokes.length,
    pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    deletedCount: deleted.length,
    firstAt,
    lastAt,
    writingMs,
    pauses,
    timingCoverage:
      strokes.length === 0
        ? "none"
        : timed.length === strokes.length
          ? "full"
          : timed.length === 0
            ? "none"
            : "partial",
  };
}
