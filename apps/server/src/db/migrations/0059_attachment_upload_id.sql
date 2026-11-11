ALTER TABLE `attachments` ADD `upload_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_teacher_upload_uk` ON `attachments` (`teacher_id`,`upload_id`);