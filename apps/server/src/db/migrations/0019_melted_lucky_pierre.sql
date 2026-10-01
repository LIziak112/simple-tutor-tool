ALTER TABLE `events` ADD `student_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `lecture_id` text;--> statement-breakpoint
CREATE INDEX `events_student_lecture_client_ts_idx` ON `events` (`student_id`,`lecture_id`,`client_ts`);