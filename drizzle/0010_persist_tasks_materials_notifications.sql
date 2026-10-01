CREATE TABLE `materials` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`shareCode` varchar(16) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`subject` varchar(120) NOT NULL,
	`topic` varchar(120) NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`groupIds` json NOT NULL,
	`studentIds` json NOT NULL,
	`uploadedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `materials_id` PRIMARY KEY(`id`),
	CONSTRAINT `materials_shareCode_unique` UNIQUE(`shareCode`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`isRead` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_submissions` (
	`id` varchar(32) NOT NULL,
	`taskId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`status` enum('NOT_STARTED','IN_PROGRESS','SUBMITTED','LATE','REVIEWED') NOT NULL,
	`files` json NOT NULL,
	`submittedAt` timestamp,
	`comment` text,
	CONSTRAINT `task_submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_submissions_task_student_unique` UNIQUE(`taskId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`shareCode` varchar(16) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`deadline` timestamp NOT NULL,
	`groupIds` json NOT NULL,
	`studentIds` json NOT NULL,
	`attachments` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `tasks_shareCode_unique` UNIQUE(`shareCode`)
);
--> statement-breakpoint
CREATE INDEX `materials_workspace_idx` ON `materials` (`providerWorkspaceId`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_idx` ON `tasks` (`providerWorkspaceId`);