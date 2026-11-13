import {
  type InkDeletedStroke,
  type InkMaterialFacet,
  type LearningRecord,
  type SelfReviewRecord,
  TIMELINE_MAX_ENTRIES,
  type TimelineEntry,
} from "@tutor/contract";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  aiFacts,
  annotations,
  events,
  ink as inkTable,
  notes,
  noteVersions,
  type ResponseRow,
} from "../db/schema.ts";
import { strokeTimings } from "./learning-record-ink-stats.ts";

// ---------- 时间线（§6；现算，不新建表） ----------

export function timelineOf(
  db: Db,
  attempt: Attempt,
  row: ResponseRow,
  materials: readonly InkMaterialFacet[],
  showJudgment: boolean,
  selfReview: SelfReviewRecord | null,
): LearningRecord["timeline"] {
  const entries: TimelineEntry[] = [];
  const push = (entry: TimelineEntry): void => {
    entries.push(entry);
  };

  // ① 事件（题目级 + 页级/整卷级；questionId 为 NULL 的页级事件也属于本题记录）
  const eventRows = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.attemptId, attempt.id),
        or(eq(events.questionId, row.questionId), isNull(events.questionId)),
      ),
    )
    .orderBy(asc(events.clientTs))
    .all();
  for (const event of eventRows) {
    let kind: TimelineEntry["kind"];
    switch (event.type) {
      case "question_view":
        kind = "view";
        break;
      case "question_focus":
        kind = "focus";
        break;
      case "question_blur":
        kind = "blur";
        break;
      case "page_hidden":
        kind = "hidden";
        break;
      case "page_visible":
        kind = "visible";
        break;
      case "idle_start":
        kind = "idle_start";
        break;
      case "idle_end":
        kind = "idle_end";
        break;
      case "answer_change":
        kind = "answer_change";
        break;
      case "hint_open":
        kind = "hint_open";
        break;
      case "directive_interact":
        kind = "directive_interact";
        break;
      case "question_submit":
        kind = "question_submit";
        break;
      case "submit":
        kind = "submit";
        break;
      default:
        continue; // 其余事件种类不进时间线（ink_stroke_batch 等计数类由文档承载）
    }
    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    const detail: TimelineEntry["detail"] = {};
    if (typeof payload.index === "number") detail.index = payload.index;
    if (typeof payload.name === "string") detail.name = payload.name;
    push({
      at: event.clientTs,
      kind,
      source: "event",
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  }

  // ② 笔画与删除（三份文档的 startedAt / deletedAt——「过程」主体）。
  // maxStrokeEnd 为 timelineOf 局部（评审 #11695：模块级可变状态是反模式）
  let maxStrokeEnd = 0;
  for (const material of materials) {
    if (!material.present) continue;
    const source =
      material.kind === "draft"
        ? "note"
        : material.kind === "annotation"
          ? "annotation"
          : "ink";
    // 被擦笔画也在 strokes∪deleted 口径内（设计稿 §6.1）——「什么时候写的」
    // 是被擦内容最有价值的一半，erase 条目只记「什么时候没的」
    for (const stroke of [...material.strokes, ...material.deleted]) {
      if (stroke.startedAt === undefined) continue;
      push({
        at: stroke.startedAt,
        kind: "stroke",
        source,
        material: material.kind,
        ...(stroke.id !== undefined ? { strokeIds: [stroke.id] } : {}),
        detail: {
          durationMs: stroke.points.at(-1)?.t ?? 0,
          ...(stroke.pointer !== undefined ? { pointer: stroke.pointer } : {}),
        },
      });
    }
    // 删除条目：同一 deletedAt 合并（一次拖动擦多笔 / 清空）
    const byDeletedAt = new Map<number, InkDeletedStroke[]>();
    for (const tomb of material.deleted) {
      const group = byDeletedAt.get(tomb.deletedAt) ?? [];
      group.push(tomb);
      byDeletedAt.set(tomb.deletedAt, group);
    }
    for (const [deletedAt, group] of byDeletedAt) {
      // 时间线 kind 记「erase」（墓碑 deletedBy 记「eraser」——删除工具语义）
      const deletedBy = group[0]?.deletedBy ?? "eraser";
      push({
        at: deletedAt,
        kind: deletedBy === "eraser" ? "erase" : deletedBy,
        source,
        material: material.kind,
        strokeIds: group.map((tomb) => tomb.id),
      });
    }
    // maxStrokeEnd 供 skew 估算
    for (const timing of strokeTimings([
      ...material.strokes,
      ...material.deleted,
    ])) {
      if (timing.startedAt !== undefined && timing.endMs > maxStrokeEnd) {
        maxStrokeEnd = timing.endMs;
      }
    }
  }

  // ③ note_version / seal
  const noteRows = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attempt.id),
        eq(notes.questionId, row.questionId),
      ),
    )
    .all();
  for (const note of noteRows) {
    const versions = db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, note.id))
      .orderBy(asc(noteVersions.revision))
      .all();
    for (const version of versions) {
      push({
        at: Date.parse(version.serverSavedAt),
        kind: "note_version",
        source: "note",
        detail: {
          revision: version.revision,
          strokeCount: version.strokeCount,
        },
      });
    }
    if (note.sealedAt !== null) {
      push({ at: Date.parse(note.sealedAt), kind: "seal", source: "note" });
    }
  }
  const annotationRows = db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.attemptId, attempt.id),
        eq(annotations.questionId, row.questionId),
      ),
    )
    .all();
  for (const annotation of annotationRows) {
    if (annotation.sealedAt !== null) {
      push({
        at: Date.parse(annotation.sealedAt),
        kind: "seal",
        source: "annotation",
      });
    }
  }

  // ④ 判定 / 自评
  const gradedAt = row.submittedAt ?? attempt.submittedAt;
  if (
    showJudgment &&
    gradedAt !== null &&
    (row.autoCorrect !== null || row.finalCorrect !== null)
  ) {
    push({
      at: Date.parse(gradedAt),
      kind: "graded",
      source: "grading",
      detail: { gradingPolicy: row.gradingPolicy },
    });
  }
  const selfReviewAt = selfReview === null ? NaN : Date.parse(selfReview.at);
  if (Number.isFinite(selfReviewAt)) {
    push({
      at: selfReviewAt,
      kind: "self_review",
      source: "grading",
    });
  }

  // ⑤ AI 任务事实（仅 id 与提交前后；内容不进时间线）
  const facts = db
    .select()
    .from(aiFacts)
    .where(
      and(
        eq(aiFacts.attemptId, attempt.id),
        eq(aiFacts.questionId, row.questionId),
      ),
    )
    .all();
  for (const fact of facts) {
    if (fact.type !== "task_created" && fact.type !== "reply_received")
      continue;
    push({
      at: Date.parse(fact.serverTs),
      kind: fact.type === "task_created" ? "ai_task" : "ai_reply",
      source: "ai",
      detail: { taskId: fact.taskId, beforeSubmit: fact.beforeSubmit },
    });
  }

  entries.sort((a, b) => a.at - b.at);
  const truncated = entries.length > TIMELINE_MAX_ENTRIES;
  const kept = truncated ? entries.slice(0, TIMELINE_MAX_ENTRIES) : entries;

  // serverSkewMs：服务端确认时刻 − 最晚落笔结束（毫秒级偏差，只提示不校正）
  const serverSavedCandidates = [
    ...noteRows.map((note) => note.serverSavedAt),
    ...annotationRows.map((annotation) => annotation.updatedAt),
    // 评审 #11695 顺手项：正式手写行的时间也要进 skew 候选（只有正式手写的
    // 题最常见，漏了它 skew 恒 null）
    (() => {
      const inkRow = db
        .select()
        .from(inkTable)
        .where(
          and(
            eq(inkTable.attemptId, attempt.id),
            eq(inkTable.questionId, row.questionId),
          ),
        )
        .get();
      return inkRow?.updatedAt ?? null;
    })(),
  ].filter((value): value is string => value !== null);
  let serverSkewMs: number | null = null;
  if (maxStrokeEnd > 0 && serverSavedCandidates.length > 0) {
    const latestServer = Math.max(
      ...serverSavedCandidates.map((value) => Date.parse(value)),
    );
    serverSkewMs = latestServer - maxStrokeEnd;
  }

  return {
    entries: kept,
    clock: { basis: "client", serverSkewMs },
    truncated,
  };
}
