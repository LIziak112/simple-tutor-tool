ALTER TABLE `assignments` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `assignments_teacher_idx` ON `assignments` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `courses_teacher_idx` ON `courses` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `imports` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `imports_teacher_idx` ON `imports` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `lectures` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `lectures_teacher_idx` ON `lectures` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `library_folders` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `library_folders_teacher_idx` ON `library_folders` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `question_knowledge` ADD `teacher_id` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `teacher_id` text;--> statement-breakpoint
ALTER TABLE `students` ADD `teacher_id` text;--> statement-breakpoint
CREATE INDEX `students_teacher_idx` ON `students` (`teacher_id`);--> statement-breakpoint
ALTER TABLE `teachers` ADD `login_name` text;--> statement-breakpoint
ALTER TABLE `teachers` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teachers` ADD `disabled_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `teachers_login_name_uk` ON `teachers` (`login_name`);--> statement-breakpoint
ALTER TABLE `units` ADD `teacher_id` text;