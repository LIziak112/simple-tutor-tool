ALTER TABLE `imports` ADD `source_path` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `batch_id` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `folder_id` text REFERENCES library_folders(id);