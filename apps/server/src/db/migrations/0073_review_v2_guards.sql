CREATE TRIGGER ai_review_v2_report_immutable
BEFORE UPDATE OF report_json, report_digest ON ai_review_v2_tasks
WHEN OLD.report_json IS NOT NULL AND (NEW.report_json IS NOT OLD.report_json OR NEW.report_digest IS NOT OLD.report_digest)
BEGIN SELECT RAISE(ABORT, 'ai_review_v2_report_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER ai_review_v2_task_identity_immutable
BEFORE UPDATE OF run_id, student_id, ordinal, kind, question_nos_json ON ai_review_v2_tasks
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.student_id IS NOT OLD.student_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind OR NEW.question_nos_json IS NOT OLD.question_nos_json
BEGIN SELECT RAISE(ABORT, 'ai_review_v2_task_identity_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER ai_review_v2_task_owner_guard
BEFORE INSERT ON ai_review_v2_tasks
WHEN NOT EXISTS(SELECT 1 FROM ai_review_v2_runs r WHERE r.id=NEW.run_id AND r.student_id=NEW.student_id)
BEGIN SELECT RAISE(ABORT, 'ai_review_v2_task_owner_guard'); END;
--> statement-breakpoint
CREATE TRIGGER ai_review_v2_audit_no_update
BEFORE UPDATE ON ai_review_v2_audit
BEGIN SELECT RAISE(ABORT, 'ai_review_v2_audit_append_only'); END;
--> statement-breakpoint
CREATE TRIGGER ai_review_v2_audit_no_delete
BEFORE DELETE ON ai_review_v2_audit
BEGIN SELECT RAISE(ABORT, 'ai_review_v2_audit_append_only'); END;
