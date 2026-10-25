CREATE TABLE `ai_attempt_review_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`student_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text,
	`server_ts` text NOT NULL,
	CONSTRAINT "ai_attempt_review_facts_type_check" CHECK("ai_attempt_review_facts"."type" in ('task_created', 'claimed', 'replied', 'opened', 'failed', 'late_reply', 'cancelled', 'archived', 'retried', 'paused'))
);
--> statement-breakpoint
CREATE INDEX `ai_attempt_review_facts_task_ts_idx` ON `ai_attempt_review_facts` (`task_id`,`server_ts`);--> statement-breakpoint
CREATE INDEX `ai_attempt_review_facts_attempt_ts_idx` ON `ai_attempt_review_facts` (`attempt_id`,`server_ts`);--> statement-breakpoint
CREATE TABLE `ai_attempt_review_results` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`generation` integer NOT NULL,
	`report_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `ai_attempt_review_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_attempt_review_results_task_generation_uk` ON `ai_attempt_review_results` (`task_id`,`generation`);--> statement-breakpoint
CREATE TABLE `ai_attempt_review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`channel` text DEFAULT 'mcp' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`snapshot_version` text NOT NULL,
	`context_snapshot_json` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`question_count` integer NOT NULL,
	`counts_json` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_until` text,
	`lease_token` text,
	`error_text` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`opened_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_attempt_review_tasks_channel_check" CHECK("ai_attempt_review_tasks"."channel" = 'mcp'),
	CONSTRAINT "ai_attempt_review_tasks_status_check" CHECK("ai_attempt_review_tasks"."status" in ('created', 'claimed', 'replied', 'failed', 'paused', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `ai_attempt_review_tasks_student_created_idx` ON `ai_attempt_review_tasks` (`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_attempt_review_tasks_attempt_status_idx` ON `ai_attempt_review_tasks` (`attempt_id`,`status`);--> statement-breakpoint
CREATE INDEX `ai_attempt_review_tasks_status_lease_idx` ON `ai_attempt_review_tasks` (`status`,`lease_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_attempt_review_tasks_mutation_id_uk` ON `ai_attempt_review_tasks` (`mutation_id`);