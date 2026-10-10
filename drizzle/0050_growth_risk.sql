CREATE TABLE `growth_settings` (
	`workspaceId` varchar(32) NOT NULL,
	`riskEnabled` boolean NOT NULL DEFAULT true,
	`digestEnabled` boolean NOT NULL DEFAULT true,
	`parentReports` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `growth_settings_workspaceId` PRIMARY KEY(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `report_shares` (
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
	CONSTRAINT `report_shares_token_uq` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `risk_actions` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`type` varchar(16) NOT NULL,
	`refId` varchar(64),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `risk_actions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `risk_history` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`dayKey` varchar(10) NOT NULL,
	`score` int NOT NULL,
	`level` varchar(8) NOT NULL,
	CONSTRAINT `risk_history_workspaceId_studentId_dayKey_pk` PRIMARY KEY(`workspaceId`,`studentId`,`dayKey`)
);
--> statement-breakpoint
CREATE TABLE `student_risk` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`score` int NOT NULL,
	`level` varchar(8) NOT NULL,
	`reasons` json NOT NULL,
	`computedAt` timestamp NOT NULL,
	`dismissedUntil` timestamp,
	`dismissedScore` int,
	CONSTRAINT `student_risk_workspaceId_studentId_pk` PRIMARY KEY(`workspaceId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `teacher_student_notes` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`body` text NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `teacher_student_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `report_shares_student_idx` ON `report_shares` (`workspaceId`,`studentId`);--> statement-breakpoint
CREATE INDEX `risk_actions_student_idx` ON `risk_actions` (`workspaceId`,`studentId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `risk_history_day_idx` ON `risk_history` (`workspaceId`,`dayKey`);--> statement-breakpoint
CREATE INDEX `student_risk_level_idx` ON `student_risk` (`workspaceId`,`level`);--> statement-breakpoint
CREATE INDEX `teacher_student_notes_student_idx` ON `teacher_student_notes` (`workspaceId`,`studentId`,`createdAt`);