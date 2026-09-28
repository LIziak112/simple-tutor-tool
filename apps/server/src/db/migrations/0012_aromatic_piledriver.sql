PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `attempts` ADD `source_type` text DEFAULT 'assignment' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `course_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `attempt_no` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`source_type` text DEFAULT 'assignment' NOT NULL,
	`assignment_id` text,
	`course_id` text,
	`unit_id` text,
	`attempt_no` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`submitted_at` text,
	`active_sec` integer,
	`device` text,
	`score_auto` integer,
	`score_final` integer,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_attempts`("id", "student_id", "source_type", "assignment_id", "course_id", "unit_id", "attempt_no", "status", "started_at", "submitted_at", "active_sec", "device", "score_auto", "score_final") SELECT "id", "student_id", "source_type", "assignment_id", "course_id", "unit_id", "attempt_no", "status", "started_at", "submitted_at", "active_sec", "device", "score_auto", "score_final" FROM `attempts`;--> statement-breakpoint
DROP TABLE `attempts`;--> statement-breakpoint
ALTER TABLE `__new_attempts` RENAME TO `attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `attempts_student_assignment_idx` ON `attempts` (`student_id`,`assignment_id`);--> statement-breakpoint
CREATE INDEX `attempts_student_course_unit_idx` ON `attempts` (`student_id`,`course_id`,`unit_id`);
