CREATE TABLE `kernel_response_marks` (
	`attempt_id` text NOT NULL,
	`response_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`mark` text,
	`comment` text,
	`command_json` text,
	`result_json` text,
	PRIMARY KEY(`attempt_id`, `teacher_id`, `operation_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`response_id`) REFERENCES `responses`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kernel_response_mark_completion" CHECK("kernel_response_marks"."command_json" IS NOT NULL OR "kernel_response_marks"."result_json" IS NOT NULL),
	CONSTRAINT "kernel_response_mark_revision" CHECK("kernel_response_marks"."base_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_response_mark_pending` ON `kernel_response_marks` (`response_id`) WHERE "kernel_response_marks"."result_json" IS NULL;