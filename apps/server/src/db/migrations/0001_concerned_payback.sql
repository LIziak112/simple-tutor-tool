CREATE TABLE `login_failures` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`locked_until` text
);
