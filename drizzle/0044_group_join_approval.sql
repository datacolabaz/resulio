CREATE TABLE `group_join_declines` (
	`groupId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`declinedBy` int,
	`declinedAt` timestamp NOT NULL,
	CONSTRAINT `group_join_declines_groupId_userId_pk` PRIMARY KEY(`groupId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `group_join_settings` (
	`groupId` varchar(32) NOT NULL,
	`approvalRequired` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `group_join_settings_groupId` PRIMARY KEY(`groupId`)
);
