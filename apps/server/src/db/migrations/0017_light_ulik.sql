PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assignment_units` (
	`assignment_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`order` integer NOT NULL,
	PRIMARY KEY(`assignment_id`, `unit_id`),
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_assignment_units`("assignment_id", "unit_id", "order") SELECT "assignment_id", "unit_id", "order" FROM `assignment_units`;--> statement-breakpoint
DROP TABLE `assignment_units`;--> statement-breakpoint
ALTER TABLE `__new_assignment_units` RENAME TO `assignment_units`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_id` text,
	`unit_id` text,
	`course_id` text,
	`title` text NOT NULL,
	`due_at` text,
	`answer_release` text DEFAULT 'on_submit' NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_assignments`("id", "teacher_id", "unit_id", "course_id", "title", "due_at", "answer_release", "deleted_at", "created_at") SELECT "id", "teacher_id", "unit_id", "course_id", "title", "due_at", "answer_release", "deleted_at", "created_at" FROM `assignments`;--> statement-breakpoint
DROP TABLE `assignments`;--> statement-breakpoint
ALTER TABLE `__new_assignments` RENAME TO `assignments`;--> statement-breakpoint
CREATE INDEX `assignments_teacher_idx` ON `assignments` (`teacher_id`);--> statement-breakpoint
CREATE TABLE `__new_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`source_type` text DEFAULT 'assignment' NOT NULL,
	`assignment_id` text,
	`course_id` text,
	`unit_id` text,
	`attempt_no` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`submitted_at` text,
	`active_sec` integer,
	`device` text,
	`score_auto` integer,
	`score_final` integer,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_attempts`("id", "student_id", "source_type", "assignment_id", "course_id", "unit_id", "attempt_no", "status", "started_at", "submitted_at", "active_sec", "device", "score_auto", "score_final") SELECT "id", "student_id", "source_type", "assignment_id", "course_id", "unit_id", "attempt_no", "status", "started_at", "submitted_at", "active_sec", "device", "score_auto", "score_final" FROM `attempts`;--> statement-breakpoint
DROP TABLE `attempts`;--> statement-breakpoint
ALTER TABLE `__new_attempts` RENAME TO `attempts`;--> statement-breakpoint
CREATE INDEX `attempts_student_assignment_idx` ON `attempts` (`student_id`,`assignment_id`);--> statement-breakpoint
CREATE INDEX `attempts_student_course_unit_idx` ON `attempts` (`student_id`,`course_id`,`unit_id`);--> statement-breakpoint
CREATE TABLE `__new_ink` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`strokes_path` text NOT NULL,
	`png_path` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`stroke_count` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_ink`("id", "attempt_id", "question_id", "strokes_path", "png_path", "width", "height", "stroke_count", "updated_at") SELECT "id", "attempt_id", "question_id", "strokes_path", "png_path", "width", "height", "stroke_count", "updated_at" FROM `ink`;--> statement-breakpoint
DROP TABLE `ink`;--> statement-breakpoint
ALTER TABLE `__new_ink` RENAME TO `ink`;--> statement-breakpoint
CREATE UNIQUE INDEX `ink_attempt_question_uk` ON `ink` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `__new_question_knowledge` (
	`teacher_id` text,
	`question_id` text NOT NULL,
	`knowledge_point_id` text NOT NULL,
	PRIMARY KEY(`teacher_id`, `question_id`, `knowledge_point_id`),
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_question_knowledge`("teacher_id", "question_id", "knowledge_point_id") SELECT "teacher_id", "question_id", "knowledge_point_id" FROM `question_knowledge`;--> statement-breakpoint
DROP TABLE `question_knowledge`;--> statement-breakpoint
ALTER TABLE `__new_question_knowledge` RENAME TO `question_knowledge`;--> statement-breakpoint
CREATE TABLE `__new_questions` (
	`id` text NOT NULL,
	`teacher_id` text,
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
	PRIMARY KEY(`teacher_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_questions`("id", "teacher_id", "unit_id", "order", "type", "difficulty", "stem_md", "options_json", "answers_json", "hints_json", "solution_md", "source_md", "version", "updated_at", "deleted_at") SELECT "id", "teacher_id", "unit_id", "order", "type", "difficulty", "stem_md", "options_json", "answers_json", "hints_json", "solution_md", "source_md", "version", "updated_at", "deleted_at" FROM `questions`;--> statement-breakpoint
DROP TABLE `questions`;--> statement-breakpoint
ALTER TABLE `__new_questions` RENAME TO `questions`;--> statement-breakpoint
CREATE TABLE `__new_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_version` integer DEFAULT 0 NOT NULL,
	`question_snapshot_json` text,
	`answer_json` text,
	`auto_correct` integer,
	`final_correct` integer,
	`teacher_mark` text,
	`teacher_comment` text,
	`active_sec` integer,
	`hints_used` integer DEFAULT 0 NOT NULL,
	`hints_opened_json` text,
	`change_count` integer DEFAULT 0 NOT NULL,
	`ink_id` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_responses`("id", "attempt_id", "question_id", "question_version", "question_snapshot_json", "answer_json", "auto_correct", "final_correct", "teacher_mark", "teacher_comment", "active_sec", "hints_used", "hints_opened_json", "change_count", "ink_id") SELECT "id", "attempt_id", "question_id", "question_version", "question_snapshot_json", "answer_json", "auto_correct", "final_correct", "teacher_mark", "teacher_comment", "active_sec", "hints_used", "hints_opened_json", "change_count", "ink_id" FROM `responses`;--> statement-breakpoint
DROP TABLE `responses`;--> statement-breakpoint
ALTER TABLE `__new_responses` RENAME TO `responses`;--> statement-breakpoint
CREATE UNIQUE INDEX `responses_attempt_question_uk` ON `responses` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `__new_units` (
	`id` text NOT NULL,
	`teacher_id` text,
	`course_id` text,
	`folder_id` text,
	`lecture_id` text,
	`title` text NOT NULL,
	`topic` text,
	`order` integer NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`teacher_id`, `id`),
	FOREIGN KEY (`folder_id`) REFERENCES `library_folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_units`("id", "teacher_id", "course_id", "folder_id", "lecture_id", "title", "topic", "order", "updated_at", "deleted_at") SELECT "id", "teacher_id", "course_id", "folder_id", "lecture_id", "title", "topic", "order", "updated_at", "deleted_at" FROM `units`;--> statement-breakpoint
DROP TABLE `units`;--> statement-breakpoint
ALTER TABLE `__new_units` RENAME TO `units`;