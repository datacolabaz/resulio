CREATE TABLE `group_code_limits` (
	`groupId` varchar(32) NOT NULL,
	`maxUses` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `group_code_limits_groupId` PRIMARY KEY(`groupId`)
);
--> statement-breakpoint
CREATE TABLE `group_member_sources` (
	`membershipId` int NOT NULL,
	`groupId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`joinedVia` varchar(32) NOT NULL,
	`sourceId` varchar(64),
	`actorUserId` int,
	`joinedAt` timestamp NOT NULL,
	`backfilled` boolean NOT NULL DEFAULT false,
	CONSTRAINT `group_member_sources_membershipId` PRIMARY KEY(`membershipId`)
);
--> statement-breakpoint
CREATE INDEX `group_member_sources_code_idx` ON `group_member_sources` (`groupId`,`joinedVia`,`sourceId`);--> statement-breakpoint
CREATE INDEX `group_member_sources_user_idx` ON `group_member_sources` (`userId`);