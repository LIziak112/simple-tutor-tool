CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`submitted_at` text,
	`active_sec` integer,
	`device` text,
	`score_auto` integer,
	`score_final` integer,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempts_student_assignment_idx` ON `attempts` (`student_id`,`assignment_id`);--> statement-breakpoint
CREATE TABLE `responses` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_version` integer DEFAULT 0 NOT NULL,
	`question_snapshot_json` text,
	`answer_json` text,
	`auto_correct` integer,
	`final_correct` integer,
	`teacher_mark` text,
	`teacher_comment` text,
	`active_sec` integer,
	`hints_used` integer DEFAULT 0 NOT NULL,
	`change_count` integer DEFAULT 0 NOT NULL,
	`ink_id` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `responses_attempt_question_uk` ON `responses` (`attempt_id`,`question_id`);