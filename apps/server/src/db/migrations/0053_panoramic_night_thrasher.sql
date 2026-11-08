CREATE TABLE `response_edit_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`response_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`kind` text NOT NULL,
	`previous_json` text,
	`reason` text NOT NULL,
	`answer_revision` integer NOT NULL,
	`created_at` text NOT NULL
);
