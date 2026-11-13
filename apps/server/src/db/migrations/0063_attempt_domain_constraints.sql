-- 冻结完成时核对新卷，保留现有历史数据和备份迁移的可读性。
CREATE TRIGGER validate_frozen_attempt_insert
BEFORE INSERT ON attempt_context_freezes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM attempts AS a
    WHERE a.id = NEW.attempt_id AND a.frozen_at IS NEW.frozen_at
      AND a.legacy_unverified = 0
      AND CASE a.source_type
        WHEN 'assignment' THEN a.assignment_id IS NOT NULL AND a.unit_id IS NULL AND a.lecture_id IS NULL
        WHEN 'course' THEN a.assignment_id IS NULL AND a.course_id IS NOT NULL AND a.unit_id IS NOT NULL AND a.lecture_id IS NULL
        WHEN 'wrong' THEN a.assignment_id IS NULL AND a.course_id IS NULL AND a.unit_id IS NULL AND a.lecture_id IS NULL
        WHEN 'lesson' THEN a.assignment_id IS NULL AND a.unit_id IS NOT NULL AND a.lecture_id IS NOT NULL
        ELSE 0
      END
  ) THEN RAISE(ABORT, '作答归属无效') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM attempts AS a
    WHERE a.id = NEW.attempt_id AND typeof(a.workflow_revision) = 'integer' AND (
      (a.practice_workflow_version IS NULL AND a.feedback_mode IS NULL AND a.workflow_revision = 0)
      OR (a.source_type <> 'lesson' AND a.practice_workflow_version = 1
        AND a.feedback_mode IN ('per_question', 'after_attempt') AND a.workflow_revision >= 0)
    )
  ) THEN RAISE(ABORT, '作答协议无效') END;
END;
--> statement-breakpoint
CREATE TRIGGER protect_frozen_attempt_ownership
BEFORE UPDATE OF source_type, assignment_id, course_id, unit_id, lecture_id, frozen_at, legacy_unverified ON attempts
WHEN EXISTS (SELECT 1 FROM attempt_context_freezes WHERE attempt_id = OLD.id)
AND (
  NEW.source_type IS NOT OLD.source_type OR NEW.assignment_id IS NOT OLD.assignment_id
  OR NEW.course_id IS NOT OLD.course_id OR NEW.unit_id IS NOT OLD.unit_id
  OR NEW.lecture_id IS NOT OLD.lecture_id OR NEW.frozen_at IS NOT OLD.frozen_at
  OR NEW.legacy_unverified IS NOT OLD.legacy_unverified
)
BEGIN
  SELECT RAISE(ABORT, '已冻结作答不能更改归属');
END;
--> statement-breakpoint
CREATE TRIGGER protect_frozen_attempt_protocol
BEFORE UPDATE OF practice_workflow_version, feedback_mode, workflow_revision ON attempts
WHEN EXISTS (SELECT 1 FROM attempt_context_freezes WHERE attempt_id = OLD.id)
AND (
  NEW.practice_workflow_version IS NOT OLD.practice_workflow_version
  OR typeof(NEW.workflow_revision) <> 'integer'
  OR CASE
    WHEN NEW.practice_workflow_version IS NULL THEN NEW.feedback_mode IS NOT NULL OR NEW.workflow_revision <> 0
    WHEN NEW.practice_workflow_version = 1 AND NEW.source_type <> 'lesson'
      THEN NEW.feedback_mode IS NULL OR NEW.feedback_mode NOT IN ('per_question', 'after_attempt')
        OR NEW.workflow_revision < OLD.workflow_revision
    ELSE 1
  END
)
BEGIN
  SELECT RAISE(ABORT, '作答协议无效');
END;
