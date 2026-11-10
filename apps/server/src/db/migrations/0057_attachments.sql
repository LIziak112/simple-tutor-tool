CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_id` text NOT NULL,
	`course_id` text,
	`file_name` text NOT NULL,
	`format` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`page_count` integer,
	`visibility` text DEFAULT 'students' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `attachments_teacher_idx` ON `attachments` (`teacher_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `attachments_course_idx` ON `attachments` (`course_id`,`deleted_at`);