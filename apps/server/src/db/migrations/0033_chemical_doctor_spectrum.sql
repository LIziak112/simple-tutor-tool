CREATE TABLE `ink_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ink_profiles_owner_idx` ON `ink_profiles` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ink_profiles_owner_name_uk` ON `ink_profiles` (`subject_type`,`subject_id`,`name`);