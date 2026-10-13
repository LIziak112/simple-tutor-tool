ALTER TABLE `attempts` ADD `lecture_id` text;--> statement-breakpoint
CREATE INDEX `attempts_student_lecture_idx` ON `attempts` (`student_id`,`lecture_id`);--> statement-breakpoint
ALTER TABLE `lectures` ADD `kind` text DEFAULT 'lecture' NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `submitted_at` text;