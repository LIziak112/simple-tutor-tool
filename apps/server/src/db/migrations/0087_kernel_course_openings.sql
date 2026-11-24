CREATE TABLE `kernel_course_openings` (
	`student_id` text NOT NULL,
	`course_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`teacher_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`practice_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`publication_json` text NOT NULL,
	`draft_json` text NOT NULL,
	`attempt_id` text,
	`step_attempt_id` text,
	PRIMARY KEY(`student_id`, `course_id`, `unit_id`, `attempt_no`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kernel_course_opening_bound" CHECK(("kernel_course_openings"."attempt_id" IS NULL) = ("kernel_course_openings"."step_attempt_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_course_openings_operation_id_unique` ON `kernel_course_openings` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_course_openings_practice_id_unique` ON `kernel_course_openings` (`practice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_course_openings_attempt_id_unique` ON `kernel_course_openings` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_course_openings_step_attempt_id_unique` ON `kernel_course_openings` (`step_attempt_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_kernel_attempt_refreezes` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`step_attempt_id` text NOT NULL,
	`expected_practice_version` integer NOT NULL,
	`practice_version` integer NOT NULL,
	`frozen_at` text NOT NULL,
	`publication_json` text NOT NULL,
	`responses_json` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_kernel_attempt_refreezes`("attempt_id", "operation_id", "step_attempt_id", "expected_practice_version", "practice_version", "frozen_at", "publication_json", "responses_json") SELECT "attempt_id", "operation_id", "step_attempt_id", "expected_practice_version", "practice_version", "frozen_at", "publication_json", "responses_json" FROM `kernel_attempt_refreezes`;--> statement-breakpoint
DROP TABLE `kernel_attempt_refreezes`;--> statement-breakpoint
ALTER TABLE `__new_kernel_attempt_refreezes` RENAME TO `kernel_attempt_refreezes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_attempt_refreezes_operation_id_unique` ON `kernel_attempt_refreezes` (`operation_id`);