CREATE TABLE `kernel_wrong_openings` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`publication_json` text NOT NULL,
	`draft_json` text NOT NULL,
	`attempt_id` text,
	`step_attempt_id` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kernel_wrong_opening_bound" CHECK(("kernel_wrong_openings"."attempt_id" IS NULL) = ("kernel_wrong_openings"."step_attempt_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_wrong_openings_attempt_id_unique` ON `kernel_wrong_openings` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_wrong_openings_step_attempt_id_unique` ON `kernel_wrong_openings` (`step_attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_wrong_openings_student_id_attempt_no_unique` ON `kernel_wrong_openings` (`student_id`,`attempt_no`);