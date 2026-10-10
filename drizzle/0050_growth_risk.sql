CREATE TABLE IF NOT EXISTS `growth_settings` (
	`workspaceId` varchar(32) NOT NULL,
	`riskEnabled` boolean NOT NULL DEFAULT true,
	`digestEnabled` boolean NOT NULL DEFAULT true,
	`parentReports` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `growth_settings_workspaceId` PRIMARY KEY(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_shares` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`viewCount` int NOT NULL DEFAULT 0,
	`lastViewedAt` timestamp,
	CONSTRAINT `report_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_shares_token_uq` UNIQUE(`tokenHash`),
	INDEX `report_shares_student_idx` (`workspaceId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `risk_actions` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`type` varchar(16) NOT NULL,
	`refId` varchar(64),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `risk_actions_id` PRIMARY KEY(`id`),
	INDEX `risk_actions_student_idx` (`workspaceId`,`studentId`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `risk_history` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`dayKey` varchar(10) NOT NULL,
	`score` int NOT NULL,
	`level` varchar(8) NOT NULL,
	CONSTRAINT `risk_history_workspaceId_studentId_dayKey_pk` PRIMARY KEY(`workspaceId`,`studentId`,`dayKey`),
	INDEX `risk_history_day_idx` (`workspaceId`,`dayKey`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `student_risk` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`score` int NOT NULL,
	`level` varchar(8) NOT NULL,
	`reasons` json NOT NULL,
	`computedAt` timestamp NOT NULL,
	`dismissedUntil` timestamp,
	`dismissedScore` int,
	CONSTRAINT `student_risk_workspaceId_studentId_pk` PRIMARY KEY(`workspaceId`,`studentId`),
	INDEX `student_risk_level_idx` (`workspaceId`,`level`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `teacher_student_notes` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`body` text NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `teacher_student_notes_id` PRIMARY KEY(`id`),
	INDEX `teacher_student_notes_student_idx` (`workspaceId`,`studentId`,`createdAt`)
);
