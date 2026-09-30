CREATE TABLE `group_email_invites` (
	`id` varchar(32) NOT NULL,
	`groupId` varchar(32) NOT NULL,
	`invitedByUserId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`status` enum('PENDING','ACCEPTED','REVOKED') NOT NULL DEFAULT 'PENDING',
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `group_email_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `group_email_invites_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `study_groups` ADD `autoJoinEnabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `group_email_invites_group_idx` ON `group_email_invites` (`groupId`);--> statement-breakpoint
CREATE INDEX `group_email_invites_email_idx` ON `group_email_invites` (`email`);