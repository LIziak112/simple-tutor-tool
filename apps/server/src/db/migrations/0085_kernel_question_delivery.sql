CREATE TABLE `kernel_lesson_openings` (
	`student_id` text NOT NULL,
	`lecture_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`course_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`practice_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`publication_json` text NOT NULL,
	`draft_json` text NOT NULL,
	`attempt_id` text,
	`step_attempt_id` text,
	PRIMARY KEY(`student_id`, `lecture_id`, `attempt_no`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kernel_lesson_opening_bound" CHECK(("kernel_lesson_openings"."attempt_id" IS NULL) = ("kernel_lesson_openings"."step_attempt_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_lesson_openings_operation_id_unique` ON `kernel_lesson_openings` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_lesson_openings_practice_id_unique` ON `kernel_lesson_openings` (`practice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_lesson_openings_attempt_id_unique` ON `kernel_lesson_openings` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_lesson_openings_step_attempt_id_unique` ON `kernel_lesson_openings` (`step_attempt_id`);--> statement-breakpoint
CREATE TABLE `kernel_question_deliveries` (
	`attempt_id` text NOT NULL,
	`step_attempt_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`intent_json` text NOT NULL,
	`receipt_id` text,
	PRIMARY KEY(`attempt_id`, `step_attempt_id`, `slot_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_question_deliveries_receipt_id_unique` ON `kernel_question_deliveries` (`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_question_deliveries_step_attempt_id_operation_id_unique` ON `kernel_question_deliveries` (`step_attempt_id`,`operation_id`);