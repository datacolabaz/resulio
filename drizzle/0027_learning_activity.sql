CREATE TABLE `learning_activity` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`versionId` varchar(32),
	`moduleId` varchar(32),
	`lessonId` varchar(32),
	`itemId` varchar(32),
	`taskId` varchar(32),
	`assessmentId` varchar(32),
	`groupId` varchar(32),
	`activityType` varchar(40) NOT NULL,
	`occurredAt` timestamp(3) NOT NULL,
	`durationSeconds` int,
	`source` enum('CLIENT','SERVER') NOT NULL,
	`metadata` json,
	CONSTRAINT `learning_activity_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `learning_activity_syllabus_idx` ON `learning_activity` (`syllabusId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `learning_activity_user_idx` ON `learning_activity` (`userId`,`syllabusId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `learning_activity_lesson_idx` ON `learning_activity` (`syllabusId`,`lessonId`,`activityType`);--> statement-breakpoint
CREATE INDEX `learning_activity_item_idx` ON `learning_activity` (`syllabusId`,`itemId`,`activityType`);