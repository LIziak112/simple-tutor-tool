CREATE TABLE `kernel_choice_amendments` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`response_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`intent_json` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `kernel_attempt_bindings`(`attempt_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`response_id`) REFERENCES `responses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_choice_amendments_operation_id_unique` ON `kernel_choice_amendments` (`operation_id`);