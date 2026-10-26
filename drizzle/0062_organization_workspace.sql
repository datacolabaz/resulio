CREATE TABLE `departments` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `departments_id` PRIMARY KEY(`id`),
	CONSTRAINT `departments_workspace_name_unique` UNIQUE(`workspaceId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`userId` int,
	`invitedEmail` varchar(320) NOT NULL,
	`role` enum('OWNER','ADMIN','HR_ADMIN','TRAINER','MANAGER') NOT NULL,
	`status` enum('PENDING','ACTIVE','REVOKED') NOT NULL DEFAULT 'PENDING',
	`departmentId` varchar(32),
	`invitedByUserId` int NOT NULL,
	`tokenHash` varchar(64),
	`expiresAt` timestamp,
	`joinedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_members_tokenHash_unique` UNIQUE(`tokenHash`),
	CONSTRAINT `workspace_members_workspace_user_unique` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE INDEX `departments_workspace_idx` ON `departments` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `workspace_members_workspace_idx` ON `workspace_members` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`userId`);--> statement-breakpoint
CREATE INDEX `workspace_members_email_idx` ON `workspace_members` (`invitedEmail`);