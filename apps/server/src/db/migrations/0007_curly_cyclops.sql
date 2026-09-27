CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text,
	`question_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`client_ts` integer NOT NULL,
	`server_ts` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_attempt_client_ts_idx` ON `events` (`attempt_id`,`client_ts`);