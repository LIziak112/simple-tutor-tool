import type { Database } from "better-sqlite3";
import { replayFocusTimeline } from "./active-time.ts";
import { recordedActiveSecTotal } from "./submission-time.ts";

interface HistoricalAttempt {
  id: string;
  status: string;
  submittedAt: string | null;
  activeSec: number | null;
}
interface HistoricalResponse {
  id: string;
  questionId: string;
  submittedAt: string | null;
  activeSec: number | null;
  hasSnapshot: number;
}
interface HistoricalEvent {
  eventOrder: number;
  type: string;
  questionId: string | null;
  clientTs: number;
  serverTs: string;
  confirmed: number;
}

/** 只返回元数据与聚合计数，不读取或输出题干、答案、笔迹与个人字段。 */
export function backfillSubmissionTime(
  db: Database,
  options: { apply?: boolean } = {},
) {
  const report = {
    candidateRows: 0,
    plannedRows: 0,
    writtenRows: 0,
    plannedAttempts: 0,
    writtenAttempts: 0,
    skipped: {
      missingBoundary: 0,
      ambiguousBoundary: 0,
      noFocusEvidence: 0,
      invalidSnapshot: 0,
      unresolvedAttempt: 0,
      openFocusInterval: 0,
    },
  };
  const attemptRows = db
    .prepare<[], HistoricalAttempt>(`
    SELECT id,status,submitted_at AS submittedAt,active_sec AS activeSec
    FROM attempts WHERE abandoned_at IS NULL AND (
      (status <> 'draft' AND active_sec IS NULL) OR EXISTS (
        SELECT 1 FROM responses r WHERE r.attempt_id=attempts.id
        AND r.submitted_at IS NOT NULL AND r.active_sec IS NULL))
  `)
    .all();
  const readRows = db.prepare<[string], HistoricalResponse>(`
    SELECT id,question_id AS questionId,submitted_at AS submittedAt,active_sec AS activeSec,
      CASE WHEN json_valid(question_snapshot_json) THEN
        CASE WHEN json_type(question_snapshot_json,'$.id')='text'
          AND json_extract(question_snapshot_json,'$.id')=question_id
          AND json_type(question_snapshot_json,'$.stemMd')='text'
          AND json_type(question_snapshot_json,'$.hints')='array' THEN 1 ELSE 0 END
      ELSE 0 END AS hasSnapshot
    FROM responses WHERE attempt_id=?
  `);
  const readEvents = db.prepare<[string], HistoricalEvent>(`
    SELECT rowid AS eventOrder,type,question_id AS questionId,client_ts AS clientTs,server_ts AS serverTs,
      CASE WHEN type='submit' AND json_valid(payload_json)
        THEN coalesce(json_extract(payload_json,'$.confirmed'),0) ELSE 0 END AS confirmed
    FROM events WHERE attempt_id=? ORDER BY rowid
  `);
  const writeRow = db.prepare<[number, string]>(
    "UPDATE responses SET active_sec=? WHERE id=? AND active_sec IS NULL",
  );
  const writeAttempt = db.prepare<[number, string]>(
    "UPDATE attempts SET active_sec=? WHERE id=? AND active_sec IS NULL",
  );
  const execute = () => {
    for (const attempt of attemptRows) {
      const finished =
        attempt.status !== "draft" && attempt.submittedAt !== null;
      const rows = readRows.all(attempt.id);
      const timeline = readEvents.all(attempt.id);
      const finalMarkers = timeline.filter(
        (e) => e.confirmed === 1 && e.serverTs === attempt.submittedAt,
      );
      let unresolved = false;
      for (const row of rows) {
        if (row.activeSec !== null || (!finished && row.submittedAt === null))
          continue;
        report.candidateRows++;
        if (!row.hasSnapshot) {
          report.skipped.invalidSnapshot++;
          continue;
        }
        const submittedAt = row.submittedAt ?? attempt.submittedAt;
        const submittedMs = Date.parse(submittedAt ?? "");
        if (!Number.isFinite(submittedMs)) {
          report.skipped.missingBoundary++;
          unresolved = true;
          continue;
        }
        // question_submit 可经普通学生事件入口伪造，绝不以其形态或 clientTs 作边界。
        // 仅 confirmed 整卷标记为服务端专有（客户端契约剥除该键）。旧卷没有它时，
        // 直接按数据库提交时间与服务端接收时间比较；同毫秒且无顺序证据就留空。
        const eligible = timeline.filter(
          (e) => !["submit", "hint_open", "question_submit"].includes(e.type),
        );
        if (eligible.some((e) => !Number.isFinite(Date.parse(e.serverTs)))) {
          report.skipped.missingBoundary++;
          unresolved = true;
          continue;
        }
        const useFinal = finished && submittedAt === attempt.submittedAt;
        if (useFinal && finalMarkers.length > 1) {
          report.skipped.ambiguousBoundary++;
          unresolved = true;
          continue;
        }
        const finalMarker = useFinal ? finalMarkers[0] : undefined;
        if (
          !finalMarker &&
          eligible.some((e) => Date.parse(e.serverTs) === submittedMs)
        ) {
          report.skipped.ambiguousBoundary++;
          unresolved = true;
          continue;
        }
        const before = finalMarker
          ? eligible.filter((e) => e.eventOrder < finalMarker.eventOrder)
          : eligible.filter((e) => Date.parse(e.serverTs) < submittedMs);
        const replay = replayFocusTimeline(before);
        if (replay.openQuestionId === row.questionId) {
          report.skipped.openFocusInterval++;
          unresolved = true;
          continue;
        }
        const value = replay.activeSecByQuestion[row.questionId];
        if (value === undefined) {
          report.skipped.noFocusEvidence++;
          continue;
        }
        report.plannedRows++;
        if (options.apply)
          report.writtenRows += writeRow.run(value, row.id).changes;
        row.activeSec = value;
      }
      if (!finished || attempt.activeSec !== null) continue;
      if (unresolved) {
        report.skipped.unresolvedAttempt++;
        continue;
      }
      const value = recordedActiveSecTotal(
        rows.filter((row) => row.hasSnapshot),
      );
      if (value === null) continue;
      report.plannedAttempts++;
      if (options.apply)
        report.writtenAttempts += writeAttempt.run(value, attempt.id).changes;
    }
    return report;
  };
  // 盘点连接可为真正 readonly；apply 的所有缺值更新同事务，可重复且不覆盖既有账。
  return options.apply ? db.transaction(execute)() : execute();
}
