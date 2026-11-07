CREATE TABLE `question_process_batches` (
	`recording_id` text NOT NULL,
	`question_id` text NOT NULL,
	`segment_id` text NOT NULL,
	`first_seq` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`payload` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`recording_id`, `question_id`, `segment_id`, `first_seq`),
	FOREIGN KEY (`recording_id`) REFERENCES `question_process_recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `question_process_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_process_recordings_attempt_id_unique` ON `question_process_recordings` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `question_process_expires_idx` ON `question_process_recordings` (`expires_at`);