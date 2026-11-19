CREATE TABLE `kernel_attempt_confirmations` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`step_attempt_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`request_json` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `kernel_attempt_bindings`(`attempt_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_attempt_confirmations_operation_id_unique` ON `kernel_attempt_confirmations` (`operation_id`);