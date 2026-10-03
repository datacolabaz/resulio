ALTER TABLE `task_submissions` ADD `firstSubmittedAt` timestamp;--> statement-breakpoint
UPDATE `task_submissions` SET `firstSubmittedAt` = `submittedAt` WHERE `firstSubmittedAt` IS NULL AND `submittedAt` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `task_submissions_task_first_idx` ON `task_submissions` (`taskId`,`firstSubmittedAt`);
