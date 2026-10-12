CREATE TABLE IF NOT EXISTS `coach_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`studentId` int NOT NULL,
	`type` varchar(24) NOT NULL,
	`refId` varchar(32),
	`meta` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coach_events_id` PRIMARY KEY(`id`),
	INDEX `coach_events_student_idx` (`studentId`,`type`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coach_settings` (
	`studentId` int NOT NULL,
	`recallMode` varchar(8) NOT NULL DEFAULT 'NORMAL',
	`reminders` boolean NOT NULL DEFAULT true,
	`consentAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coach_settings_studentId` PRIMARY KEY(`studentId`)
);
