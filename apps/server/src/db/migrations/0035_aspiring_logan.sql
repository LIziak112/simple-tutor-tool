ALTER TABLE `responses` ADD `answer_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `answer_mutation_id` text;