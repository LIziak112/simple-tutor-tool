ALTER TABLE `responses` ADD `answered` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- #6980-3 回填：历史行按「有无答案对象」判 answered（判分写点口径与
-- isUnanswered 的差异仅空形态：历史空选/全空行为 NULL answer，恒 false，不受影响）
UPDATE `responses` SET `answered` = CASE WHEN `answer_json` IS NOT NULL THEN 1 ELSE 0 END;
