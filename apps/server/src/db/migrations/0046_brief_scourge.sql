CREATE TABLE `ai_prompt_overrides` (
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_type`, `owner_id`, `slot_key`)
);
