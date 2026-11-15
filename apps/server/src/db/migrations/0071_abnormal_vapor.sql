CREATE TABLE `ai_review_v2_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`student_id` text NOT NULL,
	`type` text NOT NULL,
	`generation` integer NOT NULL,
	`server_ts` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `ai_review_v2_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_review_v2_audit_type_ck" CHECK("ai_review_v2_audit"."type" = 'late_reply')
);
--> statement-breakpoint
CREATE INDEX `ai_review_v2_audit_task_idx` ON `ai_review_v2_audit` (`task_id`,`server_ts`);--> statement-breakpoint
CREATE TABLE `ai_review_v2_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`preview_version` text NOT NULL,
	`scope_json` text NOT NULL,
	`profile` text NOT NULL,
	`purpose` text NOT NULL,
	`question_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_review_v2_runs_count_ck" CHECK("ai_review_v2_runs"."question_count" > 0),
	CONSTRAINT "ai_review_v2_runs_profile_ck" CHECK("ai_review_v2_runs"."profile" IN ('objective','essay'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_review_v2_runs_mutation_uk` ON `ai_review_v2_runs` (`student_id`,`mutation_id`);--> statement-breakpoint
CREATE INDEX `ai_review_v2_runs_owner_idx` ON `ai_review_v2_runs` (`student_id`,`attempt_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_review_v2_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`student_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`question_nos_json` text NOT NULL,
	`snapshot_json` text,
	`snapshot_version` text,
	`report_json` text,
	`report_digest` text,
	`lease_token` text,
	`lease_started_at` text,
	`lease_until` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_review_v2_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_review_v2_tasks_kind_ck" CHECK("ai_review_v2_tasks"."kind" IN ('questions','summary')),
	CONSTRAINT "ai_review_v2_tasks_status_ck" CHECK("ai_review_v2_tasks"."status" IN ('blocked','created','claimed','replied','paused','cancelled')),
	CONSTRAINT "ai_review_v2_tasks_generation_ck" CHECK("ai_review_v2_tasks"."generation" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_review_v2_tasks_order_uk` ON `ai_review_v2_tasks` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `ai_review_v2_tasks_queue_idx` ON `ai_review_v2_tasks` (`student_id`,`status`,`created_at`);