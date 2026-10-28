import type { TeacherAttemptReplayData } from "@tutor/contract";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, ink, notes, noteVersions, responses } from "../db/schema";
import { requireTeacherAttempt } from "./teacher-attempt-service";

/**
 * 做题复现只读投影（hall-15077；teacher-attempt-service 的伴生模块）：
 * GET /api/teacher/attempts/:id/replay 的业务——四类事实一次取齐，全部只读，
 * 不新增持久化面；payload 解析失败的事件按坏行跳过（不中断整卷复现）。
 * 权限与详情同口径：requireTeacherAttempt（attempt→student→teacherId，域外 404
 * 不暴露存在性）。时间口径：events 是客户端毫秒（clientTs），其余三类是服务端
 * ISO——窗口取全部来源换算后的并集，混排钳制在 web replay-model 完成。
 */
export function getTeacherAttemptReplay(
  db: Db,
  teacherId: string,
  attemptId: string,
): TeacherAttemptReplayData {
  const { attempt } = requireTeacherAttempt(db, teacherId, attemptId);

  const eventRows = db
    .select({
      type: events.type,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      questionId: events.questionId,
      payloadJson: events.payloadJson,
    })
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .orderBy(asc(events.clientTs), asc(events.id))
    .all();

  const parsedEvents: TeacherAttemptReplayData["events"] = [];
  for (const row of eventRows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.payloadJson);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      continue; // 坏行跳过，不中断整卷复现
    }
    parsedEvents.push({
      type: row.type,
      clientTs: row.clientTs,
      serverTs: row.serverTs,
      questionId: row.questionId,
      payload,
    });
  }

  const noteRows = db
    .select({
      questionId: notes.questionId,
      revision: noteVersions.revision,
      savedAt: noteVersions.serverSavedAt,
      phase: notes.phase,
    })
    .from(noteVersions)
    .innerJoin(notes, eq(noteVersions.noteId, notes.id))
    .where(eq(notes.attemptId, attemptId))
    .orderBy(asc(noteVersions.serverSavedAt))
    .all();

  const inkRows = db
    .select({
      questionId: ink.questionId,
      updatedAt: ink.updatedAt,
      strokeCount: ink.strokeCount,
      revision: ink.revision,
    })
    .from(ink)
    .where(eq(ink.attemptId, attemptId))
    .orderBy(asc(ink.updatedAt))
    .all();

  const submitRows = db
    .select({
      questionId: responses.questionId,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .where(
      and(eq(responses.attemptId, attemptId), isNotNull(responses.submittedAt)),
    )
    .orderBy(asc(responses.submittedAt))
    .all();

  // 联合时间窗：事件毫秒与服务端 ISO 换算后的并集（空卷为 null）
  let windowStartMs: number | null = null;
  let windowEndMs: number | null = null;
  const widen = (ms: number): void => {
    if (Number.isNaN(ms)) return;
    if (windowStartMs === null || ms < windowStartMs) windowStartMs = ms;
    if (windowEndMs === null || ms > windowEndMs) windowEndMs = ms;
  };
  for (const event of parsedEvents) widen(event.clientTs);
  for (const row of noteRows) {
    if (row.savedAt !== null) widen(Date.parse(row.savedAt));
  }
  for (const row of inkRows) widen(Date.parse(row.updatedAt));
  for (const row of submitRows) {
    if (row.submittedAt !== null) widen(Date.parse(row.submittedAt));
  }

  return {
    attemptId: attempt.id,
    submittedAt: attempt.submittedAt,
    windowStartMs,
    windowEndMs,
    events: parsedEvents,
    noteVersions: noteRows.flatMap((row) =>
      row.savedAt === null
        ? []
        : [
            {
              questionId: row.questionId,
              revision: row.revision,
              savedAt: row.savedAt,
              phase: row.phase,
            },
          ],
    ),
    inkPoints: inkRows.map((row) => ({
      questionId: row.questionId,
      updatedAt: row.updatedAt,
      strokeCount: row.strokeCount,
      revision: row.revision,
    })),
    submitPoints: submitRows.flatMap((row) =>
      row.submittedAt === null
        ? []
        : [{ questionId: row.questionId, submittedAt: row.submittedAt }],
    ),
  };
}
