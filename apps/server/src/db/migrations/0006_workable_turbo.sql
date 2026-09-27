CREATE TABLE `ink` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`strokes_path` text NOT NULL,
	`png_path` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`stroke_count` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ink_attempt_question_uk` ON `ink` (`attempt_id`,`question_id`);