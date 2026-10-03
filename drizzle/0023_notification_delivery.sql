CREATE TABLE `notification_deliveries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`dedupeKey` varchar(191) NOT NULL,
	`event` varchar(40) NOT NULL,
	`userId` int NOT NULL,
	`channel` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'QUEUED',
	`attempts` int NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp,
	`payload` json NOT NULL,
	`error` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_deliveries_dedupeKey_unique` UNIQUE(`dedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`userId` int NOT NULL,
	`event` varchar(40) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`enabled` boolean NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_preferences_userId_event_channel_pk` PRIMARY KEY(`userId`,`event`,`channel`)
);
--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`platform` enum('ios','android','web') NOT NULL,
	`provider` varchar(16) NOT NULL,
	`token` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `push_devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `push_devices_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `task_notification_settings` (
	`taskId` varchar(32) NOT NULL,
	`aiFeedbackToStudent` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `task_notification_settings_taskId` PRIMARY KEY(`taskId`)
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_status_idx` ON `notification_deliveries` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_user_idx` ON `notification_deliveries` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`userId`);