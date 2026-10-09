CREATE TABLE `ai_model_prices` (
	`model` varchar(120) NOT NULL,
	`inputUsdPerMillion` double NOT NULL,
	`outputUsdPerMillion` double NOT NULL,
	`note` varchar(255) NOT NULL DEFAULT '',
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ai_model_prices_model` PRIMARY KEY(`model`)
);
--> statement-breakpoint
CREATE TABLE `ai_request_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int,
	`workspaceId` varchar(32),
	`feature` varchar(40) NOT NULL,
	`operationId` varchar(32),
	`model` varchar(120) NOT NULL DEFAULT '',
	`promptTokens` int NOT NULL DEFAULT 0,
	`completionTokens` int NOT NULL DEFAULT 0,
	`totalTokens` int NOT NULL DEFAULT 0,
	`tokensEstimated` boolean NOT NULL DEFAULT false,
	`costMicroUsd` bigint NOT NULL DEFAULT 0,
	`status` enum('OK','ERROR','RATE_LIMITED') NOT NULL,
	`httpStatus` int,
	`latencyMs` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_request_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_teacher_limits` (
	`userId` int NOT NULL,
	`monthlyTokenQuota` bigint,
	`dailyRequestCap` int,
	`usageResetAt` timestamp,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ai_teacher_limits_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
CREATE TABLE `file_objects` (
	`fileId` varchar(32) NOT NULL,
	`backend` varchar(16) NOT NULL,
	`bucket` varchar(63) NOT NULL,
	`objectKey` varchar(512) NOT NULL,
	`sizeBytes` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `file_objects_fileId` PRIMARY KEY(`fileId`)
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`key` varchar(64) NOT NULL,
	`value` json,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platform_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE INDEX `ai_request_logs_created_idx` ON `ai_request_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `ai_request_logs_user_idx` ON `ai_request_logs` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ai_request_logs_feature_idx` ON `ai_request_logs` (`feature`,`createdAt`);--> statement-breakpoint
INSERT IGNORE INTO `ai_model_prices` (`model`, `inputUsdPerMillion`, `outputUsdPerMillion`, `note`) VALUES
	('gemini-3.8-flash', 0.3, 2.5, 'Seeded default, editable: check ai.google.dev/gemini-api/docs/pricing'),
	('*', 0.3, 2.5, 'Any model without its own row. Seeded default, editable');