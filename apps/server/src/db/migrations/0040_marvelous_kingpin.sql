CREATE TABLE `attempt_context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_context_snapshots_kind_check" CHECK("attempt_context_snapshots"."kind" in ('material', 'group'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_context_snapshots_dedupe_uk` ON `attempt_context_snapshots` (`attempt_id`,`kind`,`source_id`,`source_version`);--> statement-breakpoint
CREATE TABLE `material_refs` (
	`teacher_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`material_id` text NOT NULL,
	`ref_order` integer NOT NULL,
	PRIMARY KEY(`teacher_id`, `owner_kind`, `owner_id`, `material_id`, `ref_order`),
	CONSTRAINT "material_refs_owner_kind_check" CHECK("material_refs"."owner_kind" in ('group', 'question'))
);
--> statement-breakpoint
CREATE INDEX `material_refs_teacher_material_idx` ON `material_refs` (`teacher_id`,`material_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`title` text,
	`source_md` text NOT NULL,
	`content_md` text NOT NULL,
	`anchors_json` text NOT NULL,
	`slots_json` text NOT NULL,
	`media_paths_json` text NOT NULL,
	`order` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`teacher_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `materials_teacher_unit_idx` ON `materials` (`teacher_id`,`unit_id`);--> statement-breakpoint
CREATE TABLE `question_group_members` (
	`teacher_id` text NOT NULL,
	`group_id` text NOT NULL,
	`question_id` text NOT NULL,
	`order` integer NOT NULL,
	PRIMARY KEY(`teacher_id`, `group_id`, `question_id`)
);
--> statement-breakpoint
CREATE INDEX `question_group_members_teacher_question_idx` ON `question_group_members` (`teacher_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `question_groups` (
	`id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`title` text,
	`label` text,
	`source_md` text NOT NULL,
	`intro_md` text NOT NULL,
	`material_refs_json` text NOT NULL,
	`question_ids_json` text NOT NULL,
	`order` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`teacher_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `question_groups_teacher_unit_idx` ON `question_groups` (`teacher_id`,`unit_id`);--> statement-breakpoint
ALTER TABLE `questions` ADD `material_refs_json` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `grading_policy` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `self_review_verdict` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `self_review_at` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `self_review_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `self_review_mutation_id` text;