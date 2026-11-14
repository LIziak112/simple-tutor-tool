import type { Db } from "../db/client.ts";

/** 只用持久化实质证据；浏览事件、焦点心跳与底图装配都不算。 */
export function hasSubstantiveAttemptEvidence(
  db: Db,
  attemptId: string,
  historical = false,
): boolean {
  const result = db.$client
    .prepare(`SELECT
    EXISTS(SELECT 1 FROM responses WHERE attempt_id=@id AND (
      answer_json IS NOT NULL OR change_count>0 OR answer_revision>0 OR submitted_at IS NOT NULL
      OR hints_used>0 OR student_flag IS NOT NULL OR ink_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM ink WHERE attempt_id=@id AND stroke_count>0)
    OR EXISTS(SELECT 1 FROM notes n JOIN note_versions v ON v.note_id=n.id
      WHERE n.attempt_id=@id AND (v.stroke_count>0 OR (@historical=1 AND n.current_revision>0)))
    OR EXISTS(SELECT 1 FROM annotations WHERE attempt_id=@id AND (stroke_count>0 OR (@historical=1 AND revision>0)))
    OR EXISTS(SELECT 1 FROM ai_tasks WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM memos WHERE student_id=(SELECT student_id FROM attempts WHERE id=@id)
      AND (anchor_attempt_id=@id OR (json_valid(context_json)
        AND json_extract(context_json,'$.session.attemptId')=@id
        AND json_extract(context_json,'$.content.questionId') IS NOT NULL)))
    OR EXISTS(SELECT 1 FROM attempt_settlements WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM submission_evidence WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM response_time_ledger WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM ai_attempt_review_tasks WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM ai_review_v2_runs WHERE attempt_id=@id)
    OR EXISTS(SELECT 1 FROM events WHERE attempt_id=@id AND type IN ('hint_open','question_submit','attempt_submit'))
    AS found`)
    .get({ id: attemptId, historical: historical ? 1 : 0 }) as {
    found: number;
  };
  return result.found !== 0;
}
