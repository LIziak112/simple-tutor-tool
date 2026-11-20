CREATE TABLE `backup_restore_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_json` text NOT NULL,
	CONSTRAINT "backup_restore_fact_json_valid" CHECK(json_valid("backup_restore_facts"."fact_json"))
);
