CREATE TABLE `assessment_student_progress` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`assignmentId` int,
	`versionId` varchar(32),
	`studentId` int NOT NULL,
	`viewedAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`expiredAt` timestamp,
	`resultReleasedAt` timestamp,
	`latestActivityAt` timestamp,
	`attemptCount` int NOT NULL DEFAULT 0,
	`activeAttemptId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assessment_student_progress_id` PRIMARY KEY(`id`),
	CONSTRAINT `assessment_progress_student_unique` UNIQUE(`assessmentId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `student_activity_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`groupId` varchar(32),
	`entityType` enum('ASSESSMENT','ASSIGNMENT','MATERIAL','FILE') NOT NULL,
	`entityId` varchar(64) NOT NULL,
	`eventType` varchar(40) NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `student_activity_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `attempts` MODIFY COLUMN `status` enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','EXPIRED_NO_ANSWERS','VOIDED') NOT NULL DEFAULT 'IN_PROGRESS';--> statement-breakpoint
ALTER TABLE `assessments` ADD `inactivityThresholdMinutes` int DEFAULT 10;--> statement-breakpoint
ALTER TABLE `attempts` ADD `lastActivityAt` timestamp;--> statement-breakpoint
ALTER TABLE `attempts` ADD `lastAutosaveAt` timestamp;--> statement-breakpoint
ALTER TABLE `attempts` ADD `lastHeartbeatAt` timestamp;--> statement-breakpoint
ALTER TABLE `attempts` ADD `answeredCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `totalQuestionCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `autoSubmittedAt` timestamp;--> statement-breakpoint
ALTER TABLE `attempts` ADD `voidedBy` int;--> statement-breakpoint
ALTER TABLE `attempts` ADD `voidedAt` timestamp;--> statement-breakpoint
ALTER TABLE `student_answers` ADD `revision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `assessment_progress_activity_idx` ON `assessment_student_progress` (`assessmentId`,`latestActivityAt`);--> statement-breakpoint
CREATE INDEX `activity_entity_idx` ON `student_activity_events` (`providerWorkspaceId`,`entityType`,`entityId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `activity_user_idx` ON `student_activity_events` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `attempts_assessment_status_idx` ON `attempts` (`assessmentId`,`status`);--> statement-breakpoint
UPDATE `attempts` SET `totalQuestionCount` = JSON_LENGTH(`questionOrder`), `lastActivityAt` = COALESCE(`submittedAt`, `startedAt`);--> statement-breakpoint
UPDATE `attempts` SET `answeredCount` = (
	SELECT COUNT(*) FROM `student_answers` s
	WHERE s.`attemptId` = `attempts`.`id`
		AND s.`answer` IS NOT NULL
		AND JSON_TYPE(s.`answer`) <> 'NULL'
		AND s.`answer` NOT IN (CAST('""' AS JSON), CAST('[]' AS JSON), CAST('{}' AS JSON))
);--> statement-breakpoint
UPDATE `attempts` SET `autoSubmittedAt` = `submittedAt` WHERE `status` = 'AUTO_SUBMITTED';--> statement-breakpoint
INSERT INTO `assessment_student_progress`
	(`assessmentId`, `assignmentId`, `versionId`, `studentId`, `startedAt`, `completedAt`, `latestActivityAt`, `attemptCount`, `activeAttemptId`)
SELECT
	a.`assessmentId`,
	(SELECT x.`assignmentId` FROM `attempts` x WHERE x.`assessmentId` = a.`assessmentId` AND x.`studentId` = a.`studentId` ORDER BY x.`attemptNo` DESC LIMIT 1),
	(SELECT x.`versionId` FROM `attempts` x WHERE x.`assessmentId` = a.`assessmentId` AND x.`studentId` = a.`studentId` ORDER BY x.`attemptNo` DESC LIMIT 1),
	a.`studentId`,
	MIN(a.`startedAt`),
	MAX(a.`submittedAt`),
	MAX(COALESCE(a.`submittedAt`, a.`startedAt`)),
	COUNT(*),
	MAX(CASE WHEN a.`status` = 'IN_PROGRESS' THEN a.`id` END)
FROM `attempts` a
GROUP BY a.`assessmentId`, a.`studentId`;