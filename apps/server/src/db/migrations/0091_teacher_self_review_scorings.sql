CREATE TABLE `teacher_self_review_scorings` (
	`teacher_id` text PRIMARY KEY NOT NULL,
	`scoring` text NOT NULL,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
