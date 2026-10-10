CREATE TABLE `group_growth_settings` (
	`groupId` varchar(32) NOT NULL,
	`selfPractice` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `group_growth_settings_groupId` PRIMARY KEY(`groupId`)
);
--> statement-breakpoint
CREATE TABLE `released_topic_levels` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`topicKey` varchar(128) NOT NULL,
	`status` varchar(16) NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `released_topic_levels_workspaceId_studentId_topicKey_pk` PRIMARY KEY(`workspaceId`,`studentId`,`topicKey`)
);
--> statement-breakpoint
CREATE TABLE `review_plan_items` (
	`id` varchar(32) NOT NULL,
	`planId` varchar(32) NOT NULL,
	`dayKey` varchar(10) NOT NULL,
	`position` int NOT NULL,
	`topicKey` varchar(128) NOT NULL,
	`label` varchar(120) NOT NULL,
	`kind` varchar(10) NOT NULL,
	`minutes` int NOT NULL,
	`status` varchar(8) NOT NULL,
	`rolloverCount` int NOT NULL DEFAULT 0,
	`refId` varchar(64),
	`doneAt` timestamp,
	CONSTRAINT `review_plan_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `review_plans` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`status` varchar(12) NOT NULL,
	`startDay` varchar(10) NOT NULL,
	`targetDay` varchar(10) NOT NULL,
	`targetSource` varchar(12) NOT NULL,
	`targetRef` varchar(64),
	`dailyMinutes` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `review_plans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `student_growth_settings` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`dailyMinutes` int NOT NULL DEFAULT 30,
	`reminders` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `student_growth_settings_workspaceId_studentId_pk` PRIMARY KEY(`workspaceId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `student_xp` (
	`studentId` int NOT NULL,
	`xp` int NOT NULL DEFAULT 0,
	`level` int NOT NULL DEFAULT 0,
	`streak` int NOT NULL DEFAULT 0,
	`longestStreak` int NOT NULL DEFAULT 0,
	`lastActiveDay` varchar(10),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `student_xp_studentId` PRIMARY KEY(`studentId`)
);
--> statement-breakpoint
CREATE TABLE `xp_events` (
	`id` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`type` varchar(16) NOT NULL,
	`points` int NOT NULL,
	`refKey` varchar(191) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `xp_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `xp_events_ref_uq` UNIQUE(`studentId`,`refKey`)
);
--> statement-breakpoint
CREATE INDEX `review_plan_items_plan_idx` ON `review_plan_items` (`planId`,`dayKey`);--> statement-breakpoint
CREATE INDEX `review_plans_student_idx` ON `review_plans` (`workspaceId`,`studentId`,`status`);--> statement-breakpoint
CREATE INDEX `xp_events_student_idx` ON `xp_events` (`studentId`,`createdAt`);