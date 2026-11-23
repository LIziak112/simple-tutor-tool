CREATE TABLE `kernel_assignment_versions` (
	`assignment_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`fingerprint` text NOT NULL,
	PRIMARY KEY(`assignment_id`, `practice_version`),
	FOREIGN KEY (`assignment_id`) REFERENCES `kernel_assignments`(`assignment_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_assignment_versions_assignment_id_fingerprint_unique` ON `kernel_assignment_versions` (`assignment_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `kernel_attempt_bindings` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`step_attempt_id` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`,`practice_version`) REFERENCES `kernel_assignment_versions`(`assignment_id`,`practice_version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_attempt_bindings_step_attempt_id_unique` ON `kernel_attempt_bindings` (`step_attempt_id`);