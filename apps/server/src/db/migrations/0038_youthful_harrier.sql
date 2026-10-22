ALTER TABLE `assignments` ADD `allow_per_question_feedback` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `practice_workflow_version` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `feedback_mode` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `workflow_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `practice_mutation_id` text;--> statement-breakpoint
ALTER TABLE `responses` ADD `practice_request_digest` text;--> statement-breakpoint
ALTER TABLE `teachers` ADD `practice_feedback_policy` text;