CREATE TABLE `create_receipts` (
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	PRIMARY KEY(`kind`, `actor_id`, `operation_id`)
);
