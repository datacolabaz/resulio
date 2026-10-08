UPDATE `study_groups` SET `joinPolicy` = 'AUTO' WHERE `joinPolicy` = 'APPROVAL';--> statement-breakpoint
ALTER TABLE `study_groups` MODIFY COLUMN `joinPolicy` enum('AUTO','MANUAL') NOT NULL DEFAULT 'AUTO';
