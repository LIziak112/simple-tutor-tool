CREATE TABLE `kernel_assignments` (
	`assignment_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
