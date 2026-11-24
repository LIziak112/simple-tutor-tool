CREATE TABLE `kernel_assignment_openings` (
	`assignment_id` text NOT NULL,
	`student_id` text NOT NULL,
	`practice_version` integer NOT NULL,
	`publication_json` text NOT NULL,
	`draft_json` text NOT NULL,
	PRIMARY KEY(`assignment_id`, `student_id`),
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`,`practice_version`) REFERENCES `kernel_assignment_versions`(`assignment_id`,`practice_version`) ON UPDATE no action ON DELETE no action
);
