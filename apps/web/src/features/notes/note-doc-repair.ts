/**
 * 草稿正文上传前预检的「就地修复」（圈画审查 P0-1）：本地坏数据不再原样
 * 空传——线上 12fed1e6/5.3-36 曾因坏字段连续 18 次 400，每次新写都整篇
 * 重传再被拒。修复只做**无损可推断**的修正：夹紧坐标到合法域、丢弃非有
 * 限数点、丢弃结构性坏笔（weight≤0 / 非法 tool / 空 color / 滤空后无点）、
 * 补齐可默认字段（宽恒 1000 / 纸高 / 背景）、截断超限单笔；产物必须整体
 * 通过契约 noteDocSchema（单源），否则返回 null 交回服务端裁决——被拒面
 * 板另有「采用云端版本」出口兜底。
 */
import {
  INK_LOGICAL_WIDTH,
  NOTE_COORD_MAX_X,
  NOTE_COORD_MAX_Y,
  NOTE_MAX_POINTS_PER_STROKE,
  NOTE_MAX_TOTAL_POINTS,
  NOTE_PAPER_HEIGHT_DEFAULT,
  NOTE_PAPER_HEIGHT_MAX,
  type NoteDoc,
  type NoteDocInput,
  noteDocSchema,
} from "@tutor/contract";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

type RepairedStroke = NoteDocInput["ink"]["strokes"][number];

/**
 * 修复本地草稿正文；不可修复（version 错 / ink 结构烂 / 修复后仍不过
 * 契约）返回 null。空笔集是合法产物（清空语义），不视为失败。
 */
export function repairNoteDoc(input: unknown): NoteDoc | null {
  if (typeof input !== "object" || input === null) return null;
  const source = input as {
    version?: unknown;
    ink?: unknown;
    paperHeightLogical?: unknown;
    background?: unknown;
  };
  if (source.version !== 1) return null;
  const ink = source.ink as
    | { width?: unknown; strokes?: unknown }
    | null
    | undefined;
  if (typeof ink !== "object" || ink === null || !Array.isArray(ink.strokes))
    return null;

  const strokes: RepairedStroke[] = [];
  let totalPoints = 0;
  for (const rawStroke of ink.strokes) {
    if (typeof rawStroke !== "object" || rawStroke === null) continue;
    const stroke = rawStroke as Record<string, unknown>;
    if (stroke.tool !== "pen" && stroke.tool !== "highlighter") continue;
    if (typeof stroke.color !== "string" || stroke.color.length === 0) continue;
    if (
      typeof stroke.weight !== "number" ||
      !Number.isFinite(stroke.weight) ||
      stroke.weight <= 0
    )
      continue;
    if (!Array.isArray(stroke.points)) continue;
    const points: Array<{ x: number; y: number; p: number; t: number }> = [];
    for (const rawPoint of stroke.points) {
      if (typeof rawPoint !== "object" || rawPoint === null) continue;
      const point = rawPoint as Record<string, unknown>;
      if (
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y) ||
        typeof point.p !== "number" ||
        !Number.isFinite(point.p) ||
        typeof point.t !== "number" ||
        !Number.isFinite(point.t)
      )
        continue;
      points.push({
        x: clamp(point.x, 0, NOTE_COORD_MAX_X),
        y: clamp(point.y, 0, NOTE_COORD_MAX_Y),
        p: clamp(point.p, 0, 1),
        t: Math.max(0, point.t),
      });
      if (points.length >= NOTE_MAX_POINTS_PER_STROKE) break; // 超限单笔截断
    }
    if (points.length === 0) continue;
    if (totalPoints + points.length > NOTE_MAX_TOTAL_POINTS) break; // 全稿超限：丢弃余笔
    totalPoints += points.length;
    strokes.push({
      ...(typeof stroke.rendering === "object" && stroke.rendering !== null
        ? { rendering: stroke.rendering as RepairedStroke["rendering"] }
        : {}),
      tool: stroke.tool,
      color: stroke.color,
      weight: stroke.weight,
      points,
    });
  }

  const paperHeightLogical =
    typeof source.paperHeightLogical === "number" &&
    Number.isFinite(source.paperHeightLogical)
      ? clamp(Math.floor(source.paperHeightLogical), 1, NOTE_PAPER_HEIGHT_MAX)
      : NOTE_PAPER_HEIGHT_DEFAULT;
  const background =
    source.background === "white" || source.background === "line"
      ? source.background
      : "grid";

  const parsed = noteDocSchema.safeParse({
    version: 1,
    ink: { width: INK_LOGICAL_WIDTH, strokes },
    paperHeightLogical,
    background,
  });
  return parsed.success ? parsed.data : null;
}
