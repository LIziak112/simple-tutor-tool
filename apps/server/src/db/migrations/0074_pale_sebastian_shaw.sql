CREATE TABLE `memo_shares` (
	`memo_id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `memos` ADD `parent_memo_seq` integer;--> statement-breakpoint
ALTER TABLE `memos` ADD `agent_request_digest` text;