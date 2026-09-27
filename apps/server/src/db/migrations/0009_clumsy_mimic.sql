CREATE TABLE `course_items` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text,
	`title` text,
	`order` integer NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`publish_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_items_course_kind_ref_uk` ON `course_items` (`course_id`,`kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `course_students` (
	`course_id` text NOT NULL,
	`student_id` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`course_id`, `student_id`),
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `data_migrations` (
	`key` text PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`order` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `courses` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `description` text;--> statement-breakpoint
ALTER TABLE `lectures` ADD `folder_id` text REFERENCES library_folders(id);--> statement-breakpoint
ALTER TABLE `lectures` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `units` ADD `folder_id` text REFERENCES library_folders(id);--> statement-breakpoint
ALTER TABLE `units` ADD `deleted_at` text;