CREATE TABLE `attempt_original_reservations` (
	`operation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`version_id` text NOT NULL,
	`revision` integer NOT NULL,
	`hash` text NOT NULL,
	`pending_version_id` text,
	`state` text NOT NULL,
	PRIMARY KEY(`attempt_id`, `operation_id`, `question_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pending_version_id`) REFERENCES `note_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_original_reservations_pin_check" CHECK((
        "attempt_original_reservations"."state" = 'pending' AND
        "attempt_original_reservations"."pending_version_id" IS NOT NULL AND
        "attempt_original_reservations"."pending_version_id" = "attempt_original_reservations"."version_id"
      ) OR (
        "attempt_original_reservations"."state" IN ('projected', 'aborted') AND
        "attempt_original_reservations"."pending_version_id" IS NULL
      ))
);
--> statement-breakpoint
CREATE INDEX `attempt_original_reservations_pending_idx` ON `attempt_original_reservations` (`pending_version_id`);