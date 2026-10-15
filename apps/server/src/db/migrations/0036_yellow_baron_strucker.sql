CREATE TABLE `ai_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`channel` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`config_json` text NOT NULL,
	`verify_status` text DEFAULT 'unverified' NOT NULL,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_connections_channel_check" CHECK("ai_connections"."channel" in ('inapp', 'mcp', 'link')),
	CONSTRAINT "ai_connections_verify_status_check" CHECK("ai_connections"."verify_status" in ('unverified', 'verified', 'failed', 'needs_rekey'))
);
--> statement-breakpoint
CREATE INDEX `ai_connections_student_channel_idx` ON `ai_connections` (`student_id`,`channel`);--> statement-breakpoint
CREATE TABLE `ai_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`student_id` text NOT NULL,
	`type` text NOT NULL,
	`before_submit` integer NOT NULL,
	`detail_json` text,
	`server_ts` text NOT NULL,
	CONSTRAINT "ai_facts_type_check" CHECK("ai_facts"."type" in ('task_created', 'link_generated', 'dispatched', 'link_viewed', 'reply_received', 'reply_delivered', 'paused', 'resumed', 'cancelled', 'failed', 'late_reply'))
);
--> statement-breakpoint
CREATE INDEX `ai_facts_task_ts_idx` ON `ai_facts` (`task_id`,`server_ts`);--> statement-breakpoint
CREATE INDEX `ai_facts_attempt_question_ts_idx` ON `ai_facts` (`attempt_id`,`question_id`,`server_ts`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`role` text NOT NULL,
	`content_md` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `ai_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_messages_role_check" CHECK("ai_messages"."role" in ('student', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX `ai_messages_task_created_idx` ON `ai_messages` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_policy_overrides` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`),
	CONSTRAINT "ai_policy_overrides_subject_type_check" CHECK("ai_policy_overrides"."subject_type" in ('student', 'assignment')),
	CONSTRAINT "ai_policy_overrides_mode_check" CHECK("ai_policy_overrides"."mode" in ('open_study', 'guided_only', 'post_submit_only'))
);
--> statement-breakpoint
CREATE TABLE `ai_quick_buttons` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`order_index` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`attachment_pref` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_quick_buttons_student_order_uk` ON `ai_quick_buttons` (`student_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `ai_share_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `ai_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_share_tickets_token_hash_uk` ON `ai_share_tickets` (`token_hash`);--> statement-breakpoint
CREATE TABLE `ai_task_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`page_index` integer NOT NULL,
	`png_path` text NOT NULL,
	`pixel_width` integer NOT NULL,
	`pixel_height` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`hash` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `ai_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_task_materials_kind_check" CHECK("ai_task_materials"."kind" in ('annotation', 'draft', 'formal_ink')),
	CONSTRAINT "ai_task_materials_state_check" CHECK("ai_task_materials"."state" in ('pending', 'ready', 'failed', 'missing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_task_materials_task_kind_page_uk` ON `ai_task_materials` (`task_id`,`kind`,`page_index`);--> statement-breakpoint
CREATE TABLE `ai_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_revision_id` text NOT NULL,
	`channel` text NOT NULL,
	`mode_at_send` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`context_snapshot_json` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`before_submit` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`lease_until` text,
	`lease_token` text,
	`reply_delivered_at` text,
	`cancel_requested_at` text,
	`error_text` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_tasks_channel_check" CHECK("ai_tasks"."channel" in ('inapp', 'mcp', 'link')),
	CONSTRAINT "ai_tasks_mode_at_send_check" CHECK("ai_tasks"."mode_at_send" in ('open_study', 'guided_only', 'post_submit_only')),
	CONSTRAINT "ai_tasks_status_check" CHECK("ai_tasks"."status" in ('created', 'dispatching', 'uncertain', 'claimed', 'replied', 'paused', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `ai_tasks_student_created_idx` ON `ai_tasks` (`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_tasks_attempt_question_idx` ON `ai_tasks` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `ai_tasks_channel_status_idx` ON `ai_tasks` (`channel`,`status`);--> statement-breakpoint
CREATE INDEX `ai_tasks_status_lease_idx` ON `ai_tasks` (`status`,`lease_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_tasks_mutation_id_uk` ON `ai_tasks` (`mutation_id`);--> statement-breakpoint
CREATE TABLE `ai_teacher_settings` (
	`teacher_id` text PRIMARY KEY NOT NULL,
	`default_mode` text NOT NULL,
	`prompts_open` text,
	`prompts_guided` text,
	`prompts_review` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "ai_teacher_settings_default_mode_check" CHECK("ai_teacher_settings"."default_mode" in ('open_study', 'guided_only', 'post_submit_only'))
);
