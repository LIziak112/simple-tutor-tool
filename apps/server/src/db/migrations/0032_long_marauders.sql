ALTER TABLE `ink` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ink` ADD `mutation_id` text;--> statement-breakpoint
ALTER TABLE `ink` ADD `body_hash` text;