CREATE TABLE `attempt_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`question_count` integer NOT NULL,
	`active_sec` integer,
	`mutation_id` text NOT NULL,
	`request_digest` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attempt_settlements_seq_check" CHECK(typeof("attempt_settlements"."seq") = 'integer' and "attempt_settlements"."seq" > 0),
	CONSTRAINT "attempt_settlements_kind_check" CHECK("attempt_settlements"."kind" in ('partial','final')),
	CONSTRAINT "attempt_settlements_count_check" CHECK(typeof("attempt_settlements"."question_count") = 'integer' and ("attempt_settlements"."question_count" > 0 or ("attempt_settlements"."kind" = 'final' and "attempt_settlements"."question_count" = 0))),
	CONSTRAINT "attempt_settlements_time_check" CHECK("attempt_settlements"."active_sec" is null or (typeof("attempt_settlements"."active_sec") = 'integer' and "attempt_settlements"."active_sec" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_settlements_seq_uk` ON `attempt_settlements` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_settlements_mutation_uk` ON `attempt_settlements` (`attempt_id`,`mutation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_settlements_final_uk` ON `attempt_settlements` (`attempt_id`) WHERE "attempt_settlements"."kind" = 'final';--> statement-breakpoint
ALTER TABLE `responses` ADD `settlement_seq` integer;--> statement-breakpoint
CREATE INDEX `responses_settlement_idx` ON `responses` (`attempt_id`,`settlement_seq`);