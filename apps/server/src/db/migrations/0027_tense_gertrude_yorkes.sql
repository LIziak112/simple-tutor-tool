CREATE TABLE `annotation_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_revision_id` text NOT NULL,
	`phase` text DEFAULT 'scratch' NOT NULL,
	`snapshot_hash` text NOT NULL,
	`base_render_version` integer NOT NULL,
	`image_path` text,
	`image_hash` text,
	`pixel_width` integer,
	`pixel_height` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "annotation_bases_phase_check" CHECK("annotation_bases"."phase" in ('scratch', 'correction')),
	CONSTRAINT "annotation_bases_state_check" CHECK("annotation_bases"."state" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `annotation_bases_attempt_question_phase_idx` ON `annotation_bases` (`attempt_id`,`question_id`,`phase`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`phase` text DEFAULT 'scratch' NOT NULL,
	`base_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`body_path` text,
	`hash` text,
	`stroke_count` integer DEFAULT 0 NOT NULL,
	`point_count` integer DEFAULT 0 NOT NULL,
	`sealed_at` text,
	`updated_at` text NOT NULL,
	`mutation_id` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_id`) REFERENCES `annotation_bases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "annotations_phase_check" CHECK("annotations"."phase" in ('scratch', 'correction'))
);
--> statement-breakpoint
CREATE INDEX `annotations_attempt_question_phase_idx` ON `annotations` (`attempt_id`,`question_id`,`phase`);--> statement-breakpoint
CREATE UNIQUE INDEX `annotations_mutation_id_uk` ON `annotations` (`mutation_id`);