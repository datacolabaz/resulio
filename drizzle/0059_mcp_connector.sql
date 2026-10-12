CREATE TABLE IF NOT EXISTS `mcp_audit_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` varchar(32),
	`clientId` varchar(64),
	`tool` varchar(64) NOT NULL,
	`args` json,
	`status` varchar(16) NOT NULL,
	`errorCode` varchar(64),
	`durationMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_audit_log_id` PRIMARY KEY(`id`),
	INDEX `mcp_audit_log_user_idx` (`userId`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_entitlements` (
	`userId` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`plan` varchar(32) NOT NULL,
	`expiresAt` timestamp,
	`grantedBy` int,
	`note` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mcp_entitlements_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_upgrade_requests` (
	`userId` int NOT NULL,
	`status` enum('OPEN','HANDLED') NOT NULL,
	`requestedAt` timestamp NOT NULL,
	`handledAt` timestamp,
	`handledBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_upgrade_requests_userId` PRIMARY KEY(`userId`),
	INDEX `mcp_upgrade_requests_status_idx` (`status`,`requestedAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_clients` (
	`id` varchar(64) NOT NULL,
	`secretHash` varchar(64),
	`name` varchar(120) NOT NULL,
	`redirectUris` json NOT NULL,
	`authMethod` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_clients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_codes` (
	`id` varchar(32) NOT NULL,
	`clientId` varchar(64) NOT NULL,
	`redirectUri` varchar(512) NOT NULL,
	`codeChallenge` varchar(128) NOT NULL,
	`scopes` varchar(255) NOT NULL,
	`resource` varchar(255) NOT NULL,
	`state` text,
	`userId` int,
	`workspaceId` varchar(32),
	`codeHash` varchar(64),
	`expiresAt` timestamp NOT NULL,
	`approvedAt` timestamp,
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_codes_codeHash_unique` UNIQUE(`codeHash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_tokens` (
	`id` varchar(32) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`kind` enum('ACCESS','REFRESH') NOT NULL,
	`clientId` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`scopes` varchar(255) NOT NULL,
	`resource` varchar(255) NOT NULL,
	`familyId` varchar(32) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`lastUsedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_tokens_tokenHash_unique` UNIQUE(`tokenHash`),
	INDEX `oauth_tokens_user_client_idx` (`userId`,`clientId`),
	INDEX `oauth_tokens_family_idx` (`familyId`)
);
--> statement-breakpoint
-- Demo teacher: the Claude connector for free, no end date. No row when the account does not exist.
INSERT IGNORE INTO `mcp_entitlements` (`userId`, `enabled`, `plan`, `expiresAt`, `note`)
SELECT `id`, true, 'demo', NULL, 'Demo teacher (migration 0059)' FROM `users` WHERE `email` = 'telmanabdulladev@gmail.com';
