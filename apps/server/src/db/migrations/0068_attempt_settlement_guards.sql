-- 用触发器表达同卷复合引用，避免重建 responses 改变冻结题序 rowid。
CREATE TRIGGER validate_response_settlement_insert
BEFORE INSERT ON responses
WHEN NEW.settlement_seq IS NOT NULL
BEGIN
  SELECT CASE WHEN typeof(NEW.settlement_seq) <> 'integer' OR NEW.settlement_seq <= 0
    OR NOT EXISTS (SELECT 1 FROM attempt_settlements s WHERE s.attempt_id = NEW.attempt_id AND s.seq = NEW.settlement_seq)
    THEN RAISE(ABORT, '结算归属无效') END;
END;
--> statement-breakpoint
CREATE TRIGGER validate_response_settlement_update
BEFORE UPDATE OF settlement_seq, attempt_id ON responses
BEGIN
  SELECT CASE WHEN OLD.settlement_seq IS NOT NULL AND
    (NEW.settlement_seq IS NOT OLD.settlement_seq OR NEW.attempt_id IS NOT OLD.attempt_id)
    THEN RAISE(ABORT, '结算归属不可变') END;
  SELECT CASE WHEN NEW.settlement_seq IS NOT NULL AND (
    typeof(NEW.settlement_seq) <> 'integer' OR NEW.settlement_seq <= 0
    OR NOT EXISTS (SELECT 1 FROM attempt_settlements s WHERE s.attempt_id = NEW.attempt_id AND s.seq = NEW.settlement_seq))
    THEN RAISE(ABORT, '结算归属无效') END;
END;
--> statement-breakpoint
CREATE TRIGGER protect_attempt_settlement_update
BEFORE UPDATE ON attempt_settlements
BEGIN
  SELECT RAISE(ABORT, '结算事实不可变');
END;
--> statement-breakpoint
CREATE TRIGGER protect_attempt_settlement_delete
BEFORE DELETE ON attempt_settlements
WHEN EXISTS (SELECT 1 FROM attempts WHERE id = OLD.attempt_id)
  AND EXISTS (SELECT 1 FROM responses WHERE attempt_id = OLD.attempt_id AND settlement_seq = OLD.seq)
BEGIN
  SELECT RAISE(ABORT, '结算仍有成员');
END;
