CREATE TABLE `memos` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`media_format` text,
	`media_bytes` integer,
	`media_sha256` text,
	`duration_sec` integer,
	`anchor_json` text NOT NULL,
	`anchor_attempt_id` text,
	`anchor_lecture_id` text,
	`tags_json` text NOT NULL,
	`source` text NOT NULL,
	`device` text NOT NULL,
	`created_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memos_student_client_uk` ON `memos` (`student_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `memos_student_recorded_idx` ON `memos` (`student_id`,`deleted_at`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `memos_student_attempt_idx` ON `memos` (`student_id`,`anchor_attempt_id`);--> statement-breakpoint
CREATE INDEX `memos_student_lecture_idx` ON `memos` (`student_id`,`anchor_lecture_id`);