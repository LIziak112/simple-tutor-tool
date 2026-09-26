CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`login_name` text NOT NULL,
	`password_hash` text,
	`link_token` text NOT NULL,
	`link_enabled` integer DEFAULT true NOT NULL,
	`password_enabled` integer DEFAULT false NOT NULL,
	`note` text,
	`archived_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_login_name_unique` ON `students` (`login_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `students_link_token_unique` ON `students` (`link_token`);