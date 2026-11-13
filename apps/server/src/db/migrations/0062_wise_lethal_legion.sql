CREATE TABLE `attempt_context_freezes` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`frozen_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
