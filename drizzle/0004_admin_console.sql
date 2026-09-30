CREATE TABLE `audit_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`actorUserId` int,
	`actorAdminRole` varchar(32),
	`action` varchar(64) NOT NULL,
	`targetType` varchar(32) NOT NULL,
	`targetId` varchar(64),
	`workspaceId` varchar(32),
	`userId` int,
	`beforeJson` json,
	`afterJson` json,
	`reason` text,
	`requestId` varchar(36),
	`ipHash` varchar(64),
	`userAgentSummary` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `feature_flag_overrides` (
	`id` int AUTO_INCREMENT NOT NULL,
	`flagKey` varchar(64) NOT NULL,
	`scopeType` enum('USER','WORKSPACE') NOT NULL,
	`scopeId` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `feature_flag_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `feature_flag_override_scope_unique` UNIQUE(`flagKey`,`scopeType`,`scopeId`)
);
--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`key` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `feature_flags_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`type` varchar(40) NOT NULL,
	`severity` enum('LOW','MEDIUM','HIGH') NOT NULL,
	`status` enum('REVIEW_REQUIRED','REVIEWED','DISMISSED') NOT NULL DEFAULT 'REVIEW_REQUIRED',
	`userId` int,
	`workspaceId` varchar(32),
	`ipHash` varchar(64),
	`details` json,
	`occurrences` int NOT NULL DEFAULT 1,
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`reviewedBy` int,
	`reviewedAt` timestamp,
	CONSTRAINT `security_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `partner_profiles` MODIFY COLUMN `status` enum('PENDING','APPROVED','REJECTED','SUSPENDED','INFO_REQUESTED') NOT NULL DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE `platform_roles` MODIFY COLUMN `role` enum('ADMIN','SUPPORT','SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER') NOT NULL;--> statement-breakpoint
UPDATE `platform_roles` SET `role` = 'SUPER_ADMIN' WHERE `role` = 'ADMIN';--> statement-breakpoint
UPDATE `platform_roles` SET `role` = 'SUPPORT_ADMIN' WHERE `role` = 'SUPPORT';--> statement-breakpoint
ALTER TABLE `platform_roles` MODIFY COLUMN `role` enum('SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER') NOT NULL;--> statement-breakpoint
ALTER TABLE `partner_profiles` ADD `applicationAnswers` json;--> statement-breakpoint
ALTER TABLE `partner_profiles` ADD `decidedBy` int;--> statement-breakpoint
ALTER TABLE `partner_profiles` ADD `decidedAt` timestamp;--> statement-breakpoint
ALTER TABLE `platform_roles` ADD `createdBy` int;--> statement-breakpoint
ALTER TABLE `users` ADD `accountStatus` enum('ACTIVE','SUSPENDED') DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `suspendedAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `sessionsValidAfter` timestamp(3);--> statement-breakpoint
ALTER TABLE `users` ADD `lastSeenAt` timestamp;--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_logs` (`actorUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_logs` (`targetType`,`targetId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_logs` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_workspace_idx` ON `audit_logs` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_logs` (`action`,`createdAt`);--> statement-breakpoint
CREATE INDEX `security_status_idx` ON `security_events` (`status`,`lastSeenAt`);--> statement-breakpoint
CREATE INDEX `security_type_idx` ON `security_events` (`type`,`lastSeenAt`);--> statement-breakpoint
CREATE INDEX `security_user_idx` ON `security_events` (`userId`);--> statement-breakpoint
CREATE INDEX `users_account_status_idx` ON `users` (`accountStatus`);--> statement-breakpoint
CREATE INDEX `users_last_seen_idx` ON `users` (`lastSeenAt`);