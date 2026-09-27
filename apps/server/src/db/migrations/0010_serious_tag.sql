PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lectures` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text,
	`folder_id` text,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`order` integer NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`folder_id`) REFERENCES `library_folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_lectures`("id", "course_id", "folder_id", "title", "markdown", "order", "updated_at", "deleted_at") SELECT "id", "course_id", "folder_id", "title", "markdown", "order", "updated_at", "deleted_at" FROM `lectures`;--> statement-breakpoint
DROP TABLE `lectures`;--> statement-breakpoint
ALTER TABLE `__new_lectures` RENAME TO `lectures`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_units` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text,
	`folder_id` text,
	`lecture_id` text,
	`title` text NOT NULL,
	`topic` text,
	`order` integer NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`folder_id`) REFERENCES `library_folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_units`("id", "course_id", "folder_id", "lecture_id", "title", "topic", "order", "updated_at", "deleted_at") SELECT "id", "course_id", "folder_id", "lecture_id", "title", "topic", "order", "updated_at", "deleted_at" FROM `units`;--> statement-breakpoint
DROP TABLE `units`;--> statement-breakpoint
ALTER TABLE `__new_units` RENAME TO `units`;