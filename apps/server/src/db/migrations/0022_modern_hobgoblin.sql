ALTER TABLE `attempts` ADD `frozen_at` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `legacy_unverified` integer DEFAULT false NOT NULL;