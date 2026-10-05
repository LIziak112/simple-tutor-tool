CREATE TABLE `note_images` (
	`id` text PRIMARY KEY NOT NULL,
	`note_version_id` text NOT NULL,
	`spec` text NOT NULL,
	`page_index` integer NOT NULL,
	`crop_x` integer NOT NULL,
	`crop_y` integer NOT NULL,
	`crop_w` integer NOT NULL,
	`crop_h` integer NOT NULL,
	`pixel_width` integer NOT NULL,
	`pixel_height` integer NOT NULL,
	`path` text NOT NULL,
	`hash` text,
	`state` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`note_version_id`) REFERENCES `note_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "note_images_spec_check" CHECK("note_images"."spec" in ('thumbnail', 'analysis')),
	CONSTRAINT "note_images_state_check" CHECK("note_images"."state" in ('pending', 'ready', 'failed', 'missing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_images_version_spec_page_uk` ON `note_images` (`note_version_id`,`spec`,`page_index`);--> statement-breakpoint
CREATE TABLE `note_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`revision` integer NOT NULL,
	`body_path` text NOT NULL,
	`hash` text NOT NULL,
	`stroke_count` integer NOT NULL,
	`point_count` integer NOT NULL,
	`paper_width` integer NOT NULL,
	`paper_height` integer NOT NULL,
	`server_saved_at` text NOT NULL,
	`render_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "note_versions_paper_width_check" CHECK("note_versions"."paper_width" = 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_versions_note_revision_uk` ON `note_versions` (`note_id`,`revision`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_revision_id` text NOT NULL,
	`phase` text DEFAULT 'scratch' NOT NULL,
	`current_revision` integer DEFAULT 0 NOT NULL,
	`current_version_id` text,
	`server_saved_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `note_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notes_phase_check" CHECK("notes"."phase" in ('scratch', 'correction', 'supplement'))
);
--> statement-breakpoint
CREATE INDEX `notes_attempt_question_phase_idx` ON `notes` (`attempt_id`,`question_id`,`phase`);--> statement-breakpoint
CREATE TABLE `submission_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`state` text NOT NULL,
	`version_id` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `note_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "submission_evidence_state_check" CHECK("submission_evidence"."state" in ('none', 'frozen', 'missing', 'legacy_unverified'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_evidence_attempt_question_uk` ON `submission_evidence` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `submission_evidence_version_idx` ON `submission_evidence` (`version_id`);