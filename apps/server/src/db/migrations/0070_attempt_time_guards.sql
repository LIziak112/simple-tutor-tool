-- 只给迁移后的新卷选择活动版本；历史（包括旧 draft）不回填。
CREATE TRIGGER attempt_time_profile_create AFTER INSERT ON attempts
BEGIN INSERT INTO attempt_time_profiles(attempt_id,version) VALUES(NEW.id,1); END;
--> statement-breakpoint
CREATE TRIGGER attempt_time_profile_update BEFORE UPDATE ON attempt_time_profiles
BEGIN SELECT RAISE(ABORT,'time profile immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_ledger_same_attempt BEFORE INSERT ON response_time_ledger
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM responses r JOIN attempt_time_profiles p ON p.attempt_id=r.attempt_id JOIN attempt_event_receipts b ON b.attempt_id=r.attempt_id WHERE r.id=NEW.response_id AND r.attempt_id=NEW.attempt_id AND p.version=NEW.version AND b.seq=NEW.boundary_seq AND b.origin='server' AND b.kind='seal') THEN RAISE(ABORT,'invalid time ledger ownership') END;
END;
--> statement-breakpoint
CREATE TRIGGER time_span_same_attempt BEFORE INSERT ON attempt_time_spans
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM response_time_ledger s WHERE s.response_id=NEW.seal_response_id AND s.attempt_id=NEW.attempt_id) OR (NEW.owner_response_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM response_time_ledger o WHERE o.response_id=NEW.owner_response_id AND o.attempt_id=NEW.attempt_id)) THEN RAISE(ABORT,'invalid time span ownership') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attempt_time_spans s WHERE s.attempt_id=NEW.attempt_id AND s.start_ms<NEW.end_ms AND NEW.start_ms<s.end_ms) THEN RAISE(ABORT,'overlapping sealed time span') END;
END;
--> statement-breakpoint
CREATE TRIGGER time_ledger_update BEFORE UPDATE ON response_time_ledger
BEGIN SELECT RAISE(ABORT,'time ledger immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_span_update BEFORE UPDATE ON attempt_time_spans
BEGIN SELECT RAISE(ABORT,'time span immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_receipt_update BEFORE UPDATE ON attempt_event_receipts
BEGIN SELECT RAISE(ABORT,'time receipt immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_ledger_delete BEFORE DELETE ON response_time_ledger WHEN EXISTS(SELECT 1 FROM attempts WHERE id=OLD.attempt_id)
BEGIN SELECT RAISE(ABORT,'time ledger immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_span_delete BEFORE DELETE ON attempt_time_spans WHEN EXISTS(SELECT 1 FROM attempts WHERE id=OLD.attempt_id)
BEGIN SELECT RAISE(ABORT,'time span immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_receipt_delete BEFORE DELETE ON attempt_event_receipts WHEN EXISTS(SELECT 1 FROM attempts WHERE id=OLD.attempt_id)
BEGIN SELECT RAISE(ABORT,'time receipt immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_profile_delete BEFORE DELETE ON attempt_time_profiles WHEN EXISTS(SELECT 1 FROM attempts WHERE id=OLD.attempt_id)
BEGIN SELECT RAISE(ABORT,'time profile immutable'); END;
--> statement-breakpoint
CREATE TRIGGER time_receipt_same_attempt BEFORE INSERT ON attempt_event_receipts
WHEN NEW.kind='event'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events e JOIN attempt_time_profiles p ON p.attempt_id=e.attempt_id WHERE e.id=NEW.event_id AND e.attempt_id=NEW.attempt_id) THEN RAISE(ABORT,'invalid receipt ownership') END;
END;
