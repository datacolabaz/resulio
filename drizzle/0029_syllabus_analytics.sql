CREATE TABLE `syllabus_analytics_settings` (
	`syllabusId` varchar(32) NOT NULL,
	`thresholds` json NOT NULL,
	`digestEnabled` boolean NOT NULL DEFAULT true,
	`updatedBy` int NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_analytics_settings_syllabusId` PRIMARY KEY(`syllabusId`)
);
--> statement-breakpoint
CREATE INDEX `learning_activity_time_idx` ON `learning_activity` (`occurredAt`);