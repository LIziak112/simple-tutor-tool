CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_id` text,
	`student_id` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_teacher_student_idx` ON `reports` (`teacher_id`,`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teachers_api_token_uk` ON `teachers` (`api_token`);