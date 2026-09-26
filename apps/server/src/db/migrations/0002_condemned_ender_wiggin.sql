CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`order` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`kind` text NOT NULL,
	`raw_md` text NOT NULL,
	`report_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_points` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_points_name_unique` ON `knowledge_points` (`name`);--> statement-breakpoint
CREATE TABLE `lectures` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`order` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `question_knowledge` (
	`question_id` text NOT NULL,
	`knowledge_point_id` text NOT NULL,
	PRIMARY KEY(`question_id`, `knowledge_point_id`),
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`order` integer NOT NULL,
	`type` text NOT NULL,
	`difficulty` integer NOT NULL,
	`stem_md` text NOT NULL,
	`options_json` text,
	`answers_json` text,
	`hints_json` text NOT NULL,
	`solution_md` text,
	`source_md` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`lecture_id` text,
	`title` text NOT NULL,
	`topic` text,
	`order` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE no action
);
