PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`student_id` text NOT NULL,
	`type` text NOT NULL,
	`before_submit` integer NOT NULL,
	`detail_json` text,
	`server_ts` text NOT NULL,
	CONSTRAINT "ai_facts_type_check" CHECK("__new_ai_facts"."type" in ('task_created', 'link_generated', 'dispatched', 'link_viewed', 'reply_received', 'reply_delivered', 'paused', 'resumed', 'cancelled', 'failed', 'late_reply', 'archived'))
);
--> statement-breakpoint
INSERT INTO `__new_ai_facts`("id", "task_id", "attempt_id", "question_id", "student_id", "type", "before_submit", "detail_json", "server_ts") SELECT "id", "task_id", "attempt_id", "question_id", "student_id", "type", "before_submit", "detail_json", "server_ts" FROM `ai_facts`;--> statement-breakpoint
DROP TABLE `ai_facts`;--> statement-breakpoint
ALTER TABLE `__new_ai_facts` RENAME TO `ai_facts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_facts_task_ts_idx` ON `ai_facts` (`task_id`,`server_ts`);--> statement-breakpoint
CREATE INDEX `ai_facts_attempt_question_ts_idx` ON `ai_facts` (`attempt_id`,`question_id`,`server_ts`);--> statement-breakpoint
ALTER TABLE `ai_tasks` ADD `archived_at` text;