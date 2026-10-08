CREATE TABLE `announcement_deliveries` (
	`announcementId` int NOT NULL,
	`subscriptionId` int NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'SENDING',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `announcement_deliveries_announcementId_subscriptionId_pk` PRIMARY KEY(`announcementId`,`subscriptionId`)
);
--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`audience` enum('ALL','SIGNED_IN','ANONYMOUS','TEACHERS','STUDENTS') NOT NULL,
	`language` varchar(8) NOT NULL,
	`texts` json NOT NULL,
	`url` varchar(500) NOT NULL,
	`status` enum('QUEUED','SENDING','SENT','FAILED') NOT NULL DEFAULT 'QUEUED',
	`createdByUserId` int NOT NULL,
	`targetUsers` int NOT NULL DEFAULT 0,
	`targetAnonymous` int NOT NULL DEFAULT 0,
	`inAppSent` int NOT NULL DEFAULT 0,
	`pushSent` int NOT NULL DEFAULT 0,
	`pushFailed` int NOT NULL DEFAULT 0,
	`error` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`finishedAt` timestamp,
	CONSTRAINT `announcements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `web_push_subscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`endpointHash` varchar(64) NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` varchar(128) NOT NULL,
	`auth` varchar(64) NOT NULL,
	`userId` int,
	`locale` varchar(8) NOT NULL DEFAULT 'az',
	`userAgent` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`failureCount` int NOT NULL DEFAULT 0,
	CONSTRAINT `web_push_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `web_push_subscriptions_endpointHash_unique` UNIQUE(`endpointHash`)
);
--> statement-breakpoint
CREATE INDEX `announcements_status_idx` ON `announcements` (`status`);--> statement-breakpoint
CREATE INDEX `web_push_subscriptions_user_idx` ON `web_push_subscriptions` (`userId`);