CREATE TABLE `kernel_attempt_refreezes` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`step_attempt_id` text NOT NULL,
	`expected_practice_version` integer NOT NULL,
	`practice_version` integer NOT NULL,
	`frozen_at` text NOT NULL,
	`publication_json` text NOT NULL,
	`responses_json` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `kernel_attempt_bindings`(`attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_attempt_refreezes_operation_id_unique` ON `kernel_attempt_refreezes` (`operation_id`);