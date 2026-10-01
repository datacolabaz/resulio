ALTER TABLE `study_groups` ADD `language` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `format` enum('ONLINE','IN_PERSON','HYBRID') DEFAULT 'ONLINE' NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `startDate` timestamp;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `classDays` varchar(64);--> statement-breakpoint
ALTER TABLE `study_groups` ADD `classTime` varchar(32);--> statement-breakpoint
ALTER TABLE `study_groups` ADD `scheduleVisible` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `joinPolicy` enum('AUTO','APPROVAL','MANUAL') DEFAULT 'APPROVAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `codeActive` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `study_groups` ADD `codeExpiresAt` timestamp;--> statement-breakpoint
UPDATE `study_groups` SET `joinPolicy` = 'AUTO' WHERE `autoJoinEnabled` = 1;--> statement-breakpoint
ALTER TABLE `study_groups` DROP COLUMN `autoJoinEnabled`;