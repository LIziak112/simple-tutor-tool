ALTER TABLE `note_versions` ADD `mutation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `note_versions_mutation_id_uk` ON `note_versions` (`mutation_id`);