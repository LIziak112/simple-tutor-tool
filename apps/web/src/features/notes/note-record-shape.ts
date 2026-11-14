import type { NoteLocalRecord } from "./note-store";

/** 全稿点数求和（revive/减笔冷路径；追加笔走增量不经过这里） */
export function countPoints(strokes: readonly { points: unknown[] }[]): number {
  let total = 0;
  for (const stroke of strokes) total += stroke.points.length;
  return total;
}

export function freshRecord(): NoteLocalRecord {
  return {
    doc: { version: 1, ink: { width: 1000, strokes: [] } },
    pending: null,
    baseRevision: 0,
    noteId: null,
    lastHead: null,
    conflict: null,
    denied: null,
    local: "saved",
    localError: null,
    editedAt: 0,
    docVersion: 0,
    totalPoints: 0,
  };
}

/** ink/strokes 形态校验（T6R.9 复审③）：坏形（历史损坏/异版本写入）弃壳
 * 返 null 重建空稿——曾在挂载/bind 扫描（getAll 原料直入）路径抛错击穿
 * 整个恢复链；只查结构不查数值（坐标/点数由写入与服务端边界管辖）。 */
function inkShapeOk(ink: unknown): boolean {
  if (typeof ink !== "object" || ink === null) return false;
  const strokes = (ink as { strokes?: unknown }).strokes;
  if (!Array.isArray(strokes)) return false;
  for (const stroke of strokes) {
    if (
      typeof stroke !== "object" ||
      stroke === null ||
      !Array.isArray((stroke as { points?: unknown }).points)
    ) {
      return false;
    }
  }
  return true;
}

/** 读取旧记录的防御性归一（前向兼容：缺字段补默认，形态错则弃重建空稿壳） */
export function reviveRecord(raw: unknown): NoteLocalRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<NoteLocalRecord>;
  if (
    r.doc === undefined ||
    typeof r.doc !== "object" ||
    !inkShapeOk((r.doc as { ink?: unknown }).ink)
  ) {
    return null;
  }
  const base = freshRecord();
  return {
    ...base,
    doc: r.doc,
    pending:
      r.pending && typeof r.pending.mutationId === "string" && r.pending.doc
        ? r.pending
        : null,
    baseRevision: typeof r.baseRevision === "number" ? r.baseRevision : 0,
    noteId: typeof r.noteId === "string" ? r.noteId : null,
    lastHead: r.lastHead ?? null,
    conflict: r.conflict ?? null,
    denied: r.denied ?? null,
    editedAt: typeof r.editedAt === "number" ? r.editedAt : 0,
    docVersion: typeof r.docVersion === "number" ? r.docVersion : 0,
    totalPoints: countPoints(r.doc.ink.strokes),
    // local/localError 持久副本恒归一化（见文件头），读取即 saved
    local: "saved",
    localError: null,
  };
}
