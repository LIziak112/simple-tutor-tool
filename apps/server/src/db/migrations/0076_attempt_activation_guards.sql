-- Custom SQL migration file, put your code below! --
-- 首次激活一旦落定不可改写；历史回填只写原本NULL的行。
CREATE TRIGGER attempt_activation_once
BEFORE UPDATE OF activated_at ON attempts
WHEN OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at
BEGIN SELECT RAISE(ABORT, 'attempt activation immutable'); END;
--> statement-breakpoint
-- 已激活/完成的卷不可绕过冻结保护；空卷重冻与整卷清除仍可走原事务路径。
CREATE TRIGGER active_attempt_freeze_delete
BEFORE DELETE ON attempt_context_freezes
WHEN EXISTS(SELECT 1 FROM attempts a WHERE a.id=OLD.attempt_id AND (a.activated_at IS NOT NULL OR a.status<>'draft'))
BEGIN SELECT RAISE(ABORT, 'active attempt freeze immutable'); END;
