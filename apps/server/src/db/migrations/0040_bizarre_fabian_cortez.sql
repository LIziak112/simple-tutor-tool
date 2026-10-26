ALTER TABLE `responses` ADD `review_policy` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `review_eligible` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `self_correct` integer;--> statement-breakpoint
ALTER TABLE `responses` ADD `review_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `review_mutation_id` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `review_mutation_hash` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `reviewed_at` text;