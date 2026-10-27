ALTER TABLE `questions` ADD `flagged` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `flaggedAt` timestamp;