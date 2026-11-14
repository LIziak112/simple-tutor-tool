CREATE TABLE `devices` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`os` text,
	`browser` text,
	`standalone` integer DEFAULT false NOT NULL,
	`automatic_name` text NOT NULL,
	`name` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`merged_into_id` text,
	PRIMARY KEY(`subject_type`, `subject_id`, `device_id`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `memos` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `memos` ADD `context_json` text;--> statement-breakpoint
ALTER TABLE `memos` ADD `device_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memos_student_seq_uk` ON `memos` (`student_id`,`seq`);