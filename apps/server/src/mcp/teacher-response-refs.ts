import { and, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { aiTasks, annotations, ink, notes, responses } from "../db/schema.ts";

/** 行的引用 id（不内联内容；AI 按 id 另取笔记版本 / 笔迹图 / 标注 / AI 任务） */
interface ResponseRefs {
  inkIds: string[];
  noteVersionIds: string[];
  annotationIds: string[];
  aiTaskIds: string[];
  /** 有 scratch 工作稿笔记行（含 0 版本行——与筛选 EXISTS 同口径） */
  hasScratchNote: boolean;
  /** 有 correction 订正笔记行 */
  hasCorrectionNote: boolean;
}

/** 存在性筛选用 EXISTS 片段（笔记阶段 / 笔迹 / 标注 / AI 任务） */
export const NOTES_SCRATCH_EXISTS = sql`exists (select 1 from notes n where n.attempt_id = ${responses.attemptId} and n.question_id = ${responses.questionId} and n.phase = 'scratch')`;
export const NOTES_CORRECTION_EXISTS = sql`exists (select 1 from notes n where n.attempt_id = ${responses.attemptId} and n.question_id = ${responses.questionId} and n.phase = 'correction')`;
export const INK_EXISTS = sql`exists (select 1 from ink i where i.attempt_id = ${responses.attemptId} and i.question_id = ${responses.questionId})`;
export const AI_TASK_EXISTS = sql`exists (select 1 from ai_tasks t where t.attempt_id = ${responses.attemptId} and t.question_id = ${responses.questionId})`;

/** 行键（attemptId + questionId；同一键多行——同题多次作答——共享引用 id） */
export function refKeyOf(attemptId: string, questionId: string): string {
  return `${attemptId}\u0000${questionId}`;
}

/** 一页行的引用 id 批量装配（4 条 IN 查询，避免逐行 EXISTS N+1） */
export function responseRefsOf(
  db: Db,
  pairs: readonly { attemptId: string; questionId: string }[],
): Map<string, ResponseRefs> {
  const map = new Map<string, ResponseRefs>();
  if (pairs.length === 0) return map;
  for (const pair of pairs) {
    map.set(refKeyOf(pair.attemptId, pair.questionId), {
      inkIds: [],
      noteVersionIds: [],
      annotationIds: [],
      aiTaskIds: [],
      hasScratchNote: false,
      hasCorrectionNote: false,
    });
  }
  const attemptIdList = [...new Set(pairs.map((p) => p.attemptId))];
  const questionIdList = [...new Set(pairs.map((p) => p.questionId))];
  for (const row of db
    .select({
      id: ink.id,
      attemptId: ink.attemptId,
      questionId: ink.questionId,
    })
    .from(ink)
    .where(
      and(
        inArray(ink.attemptId, attemptIdList),
        inArray(ink.questionId, questionIdList),
      ),
    )
    .all()) {
    map.get(refKeyOf(row.attemptId, row.questionId))?.inkIds.push(row.id);
  }
  for (const row of db
    .select({
      attemptId: notes.attemptId,
      questionId: notes.questionId,
      versionId: notes.currentVersionId,
      phase: notes.phase,
    })
    .from(notes)
    .where(
      and(
        inArray(notes.attemptId, attemptIdList),
        inArray(notes.questionId, questionIdList),
      ),
    )
    .all()) {
    const entry = map.get(refKeyOf(row.attemptId, row.questionId));
    if (entry === undefined) continue;
    if (row.phase === "scratch") entry.hasScratchNote = true;
    if (row.phase === "correction") entry.hasCorrectionNote = true;
    if (row.versionId !== null) entry.noteVersionIds.push(row.versionId);
  }
  for (const row of db
    .select({
      id: annotations.id,
      attemptId: annotations.attemptId,
      questionId: annotations.questionId,
    })
    .from(annotations)
    .where(
      and(
        inArray(annotations.attemptId, attemptIdList),
        inArray(annotations.questionId, questionIdList),
      ),
    )
    .all()) {
    map
      .get(refKeyOf(row.attemptId, row.questionId))
      ?.annotationIds.push(row.id);
  }
  for (const row of db
    .select({
      id: aiTasks.id,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
    })
    .from(aiTasks)
    .where(
      and(
        inArray(aiTasks.attemptId, attemptIdList),
        inArray(aiTasks.questionId, questionIdList),
      ),
    )
    .all()) {
    map.get(refKeyOf(row.attemptId, row.questionId))?.aiTaskIds.push(row.id);
  }
  return map;
}
