ALTER TABLE `study_groups` ADD `classSchedule` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` DROP COLUMN `classDays`;--> statement-breakpoint
ALTER TABLE `study_groups` DROP COLUMN `classTime`;