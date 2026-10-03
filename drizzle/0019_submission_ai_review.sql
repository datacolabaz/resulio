CREATE TABLE `ai_usage_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`kind` varchar(40) NOT NULL,
	`refId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_usage_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `submission_ai_reviews` (
	`id` varchar(32) NOT NULL,
	`submissionId` varchar(32) NOT NULL,
	`taskId` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`status` enum('PENDING','DONE','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
	`runId` varchar(32) NOT NULL,
	`checks` json NOT NULL,
	`model` varchar(120),
	`suggestedScore` double,
	`feedback` text,
	`details` json,
	`errorCode` varchar(40),
	`inputChars` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `submission_ai_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `submission_ai_reviews_submissionId_unique` UNIQUE(`submissionId`)
);
--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `score` double;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `teacherFeedback` text;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `gradedAt` timestamp;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `gradedByUserId` int;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `feedbackReleasedAt` timestamp;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `aiFeedbackReleased` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_usage_events_workspace_idx` ON `ai_usage_events` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `submission_ai_reviews_task_idx` ON `submission_ai_reviews` (`taskId`);