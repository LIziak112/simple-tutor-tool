/**
 * 笔画的规范化序列化：草稿（note-service 的 canonicalNoteJson）与圈画
 * （annotation-service 的 canonicalAnnotationJson）共用。
 *
 * 两处的正文都是按固定键序重建对象树之后再算 hash、落盘，笔画这一层的
 * 规则相同，放在一处：加字段只改这里，不会一边加了、另一边漏掉。
 */
import type { InkDeletedStroke, InkStroke } from "@tutor/contract";

/**
 * LR-1 规范化笔画：固定键序 {tool, color, weight, id?, startedAt?, pointer?,
 * cutFrom?, points}，每点 {x, y, p, t}；可选字段缺席不写键（旧稿的 hash 与
 * 升级前逐字节一致）。
 *
 * cutFrom 是局部擦除切出的段带的原笔记号（契约 inkStrokeSchema）。规范化
 * 正文就是落盘的字节，不写进来读回就丢了，同一笔切出的荧光笔各段会被各画
 * 各的、重叠处叠深。
 */
export function canonicalInkStroke(stroke: InkStroke): Record<string, unknown> {
  return {
    tool: stroke.tool,
    color: stroke.color,
    weight: stroke.weight,
    ...(stroke.id !== undefined ? { id: stroke.id } : {}),
    ...(stroke.startedAt !== undefined ? { startedAt: stroke.startedAt } : {}),
    ...(stroke.pointer !== undefined ? { pointer: stroke.pointer } : {}),
    ...(stroke.cutFrom !== undefined ? { cutFrom: stroke.cutFrom } : {}),
    points: stroke.points.map((p) => ({ x: p.x, y: p.y, p: p.p, t: p.t })),
  };
}

/** LR-2 规范化墓碑：笔画规范化 + 删除时刻/来源（删除态的一部分，必入 hash） */
export function canonicalDeletedStroke(
  deleted: InkDeletedStroke,
): Record<string, unknown> {
  return {
    ...canonicalInkStroke(deleted),
    deletedAt: deleted.deletedAt,
    deletedBy: deleted.deletedBy,
  };
}
