CREATE TABLE `assignment_units` (
	`assignment_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`order` integer NOT NULL,
	PRIMARY KEY(`assignment_id`, `unit_id`),
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text,
	`course_id` text,
	`title` text NOT NULL,
	`due_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_assignments`("id", "unit_id", "course_id", "title", "due_at", "deleted_at", "created_at") SELECT "id", "unit_id", "course_id", "title", "due_at", "deleted_at", "created_at" FROM `assignments`;--> statement-breakpoint
DROP TABLE `assignments`;--> statement-breakpoint
ALTER TABLE `__new_assignments` RENAME TO `assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `assignment_students` ADD `added_at` text;--> statement-breakpoint
ALTER TABLE `assignment_students` ADD `removed_at` text;