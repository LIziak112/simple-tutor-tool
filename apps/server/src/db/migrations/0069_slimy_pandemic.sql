CREATE TABLE `attempt_event_receipts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`event_id` text,
	`origin` text NOT NULL,
	`kind` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "time_receipt_source" CHECK("attempt_event_receipts"."origin" IN ('client','server') AND (("attempt_event_receipts"."kind"='event' AND "attempt_event_receipts"."event_id" IS NOT NULL) OR ("attempt_event_receipts"."kind"='seal' AND "attempt_event_receipts"."origin"='server' AND "attempt_event_receipts"."event_id" IS NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_event_receipts_event_id_unique` ON `attempt_event_receipts` (`event_id`);--> statement-breakpoint
CREATE INDEX `time_receipt_attempt_seq` ON `attempt_event_receipts` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE TABLE `attempt_time_profiles` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "time_profile_version" CHECK("attempt_time_profiles"."version"=1)
);
--> statement-breakpoint
CREATE TABLE `attempt_time_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`seal_response_id` text NOT NULL,
	`owner_response_id` text,
	`kind` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seal_response_id`) REFERENCES `response_time_ledger`(`response_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_response_id`) REFERENCES `response_time_ledger`(`response_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "time_span_shape" CHECK("attempt_time_spans"."start_ms">=0 AND "attempt_time_spans"."end_ms">"attempt_time_spans"."start_ms" AND "attempt_time_spans"."end_ms"<=9007199254740991 AND (("attempt_time_spans"."kind"='unattributed' AND "attempt_time_spans"."owner_response_id" IS NULL) OR ("attempt_time_spans"."kind" IN ('active','observed') AND "attempt_time_spans"."owner_response_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX `time_span_attempt_start` ON `attempt_time_spans` (`attempt_id`,`start_ms`);--> statement-breakpoint
CREATE TABLE `response_time_ledger` (
	`response_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`active_ms` integer,
	`observed_ms` integer,
	`active_sec` integer,
	`observed_sec` integer,
	`actions` integer NOT NULL,
	`viewed` integer NOT NULL,
	`boundary_seq` integer NOT NULL,
	`sealed_at` text NOT NULL,
	`input_digest` text NOT NULL,
	FOREIGN KEY (`response_id`) REFERENCES `responses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`boundary_seq`) REFERENCES `attempt_event_receipts`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "time_ledger_shape" CHECK("response_time_ledger"."version"=1 AND "response_time_ledger"."actions">=0 AND "response_time_ledger"."actions"<=9007199254740991 AND "response_time_ledger"."viewed" IN (0,1) AND (("response_time_ledger"."state"='unknown' AND "response_time_ledger"."reason" IS NOT NULL AND "response_time_ledger"."active_ms" IS NULL AND "response_time_ledger"."observed_ms" IS NULL AND "response_time_ledger"."active_sec" IS NULL AND "response_time_ledger"."observed_sec" IS NULL) OR ("response_time_ledger"."state"='available' AND "response_time_ledger"."reason" IS NULL AND "response_time_ledger"."active_ms" BETWEEN 0 AND 9007199254740991 AND "response_time_ledger"."observed_ms" BETWEEN 0 AND 9007199254740991 AND "response_time_ledger"."active_sec"=cast(("response_time_ledger"."active_ms"+500)/1000 as integer) AND "response_time_ledger"."observed_sec"=cast(("response_time_ledger"."observed_ms"+500)/1000 as integer))))
);
--> statement-breakpoint
CREATE INDEX `time_ledger_attempt` ON `response_time_ledger` (`attempt_id`);