CREATE TABLE `group_invite_links` (
	`id` varchar(32) NOT NULL,
	`groupId` varchar(32) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL DEFAULT '',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	`usedByUserId` int,
	`usedAt` timestamp,
	`revokedAt` timestamp,
	CONSTRAINT `group_invite_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `group_invite_links_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `group_invite_links_group_idx` ON `group_invite_links` (`groupId`,`createdAt`);