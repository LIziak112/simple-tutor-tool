import { createHash } from "node:crypto";
import {
  INK_LOGICAL_WIDTH,
  type InkDeletedStroke,
  type InkStroke,
  type NoteDoc,
} from "@tutor/contract";

// ---------- hash 规范化（契约 noteBodyHashSchema 的语义实现） ----------

/**
 * 服务端规范化序列化规则（最终定义，幂等判断同规则）：
 * - 输入是经 noteDocSchema.parse 后的 NoteDoc——默认值已物化
 *   （paperHeightLogical=800、background="grid"），客户端缺省与显式默认值
 *   得到同一 hash；
 * - 按固定键序**重建**对象树（不依赖客户端 JSON 键序）：
 *   顶层 {version, ink, paperHeightLogical, background}；ink {width, strokes}；
 *   每笔 {tool, color, weight, points}；每点 {x, y, p, t}；
 * - JSON.stringify 紧凑输出（无空白）；数值走 ECMAScript Number::toString
 *   （同值同串；NaN/±Infinity 已被 schema 拒绝；-0 序列化为 "0"）；
 * - 不参与 hash：客户端 gzip 字节（压缩相关）、客户端墙钟（NoteDoc 无时间
 *   字段）、上传通道（gzip/原始 JSON 同文同 hash）。
 */
export function canonicalNoteJson(doc: NoteDoc): string {
  return JSON.stringify({
    version: 1,
    ink: {
      width: INK_LOGICAL_WIDTH,
      strokes: doc.ink.strokes.map(canonicalInkStroke),
      // LR-2（学习记录模型设计稿 §4.2/§8）：墓碑纳入规范化——新字段只影响
      // 新文档的 hash；旧稿无墓碑不写键，hash 与升级前逐字节一致
      ...(doc.ink.deleted !== undefined && doc.ink.deleted.length > 0
        ? { deleted: doc.ink.deleted.map(canonicalDeletedStroke) }
        : {}),
    },
    paperHeightLogical: doc.paperHeightLogical,
    background: doc.background,
  });
}

/** LR-1 规范化笔画：固定键序；可选新字段（id/startedAt/pointer）缺席不写键 */
function canonicalInkStroke(stroke: InkStroke): Record<string, unknown> {
  return {
    tool: stroke.tool,
    color: stroke.color,
    weight: stroke.weight,
    ...(stroke.id !== undefined ? { id: stroke.id } : {}),
    ...(stroke.startedAt !== undefined ? { startedAt: stroke.startedAt } : {}),
    ...(stroke.pointer !== undefined ? { pointer: stroke.pointer } : {}),
    points: stroke.points.map((p) => ({ x: p.x, y: p.y, p: p.p, t: p.t })),
  };
}

/** LR-2 规范化墓碑：笔画规范化 + 删除时刻/来源（删除态的一部分，必入 hash） */
function canonicalDeletedStroke(deleted: InkDeletedStroke): unknown {
  return {
    ...canonicalInkStroke(deleted),
    deletedAt: deleted.deletedAt,
    deletedBy: deleted.deletedBy,
  };
}

/** 规范化正文 → sha-256（64 位小写 hex，契约 noteBodyHashSchema） */
export function noteDocSha256(doc: NoteDoc): string {
  return createHash("sha256")
    .update(canonicalNoteJson(doc), "utf8")
    .digest("hex");
}

/** 正文计数（note_versions 行的 strokeCount/pointCount/paperHeight 来源） */
export function noteMetrics(doc: NoteDoc): {
  strokeCount: number;
  pointCount: number;
  paperHeight: number;
} {
  let pointCount = 0;
  for (const stroke of doc.ink.strokes) pointCount += stroke.points.length;
  return {
    strokeCount: doc.ink.strokes.length,
    pointCount,
    paperHeight: doc.paperHeightLogical,
  };
}
