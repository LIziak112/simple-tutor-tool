CREATE TABLE `attempt_batch_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`batch_count` integer NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_batch_submissions_attempt_id_unique` ON `attempt_batch_submissions` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `attempt_batch_submissions_expires_idx` ON `attempt_batch_submissions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `attempt_submission_batches` (
	`submission_id` text NOT NULL,
	`batch_index` integer NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`submission_id`, `batch_index`),
	FOREIGN KEY (`submission_id`) REFERENCES `attempt_batch_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
