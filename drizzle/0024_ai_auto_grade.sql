CREATE TABLE `submission_grading` (
	`submissionId` varchar(32) NOT NULL,
	`source` enum('AI','TEACHER'),
	`autoStatus` enum('AI_GRADED','NEEDS_TEACHER'),
	`autoReason` varchar(40),
	`aiScore` double,
	`reviewRunId` varchar(32),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `submission_grading_submissionId` PRIMARY KEY(`submissionId`)
);
--> statement-breakpoint
CREATE TABLE `task_grading_settings` (
	`taskId` varchar(32) NOT NULL,
	`autoGrade` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `task_grading_settings_taskId` PRIMARY KEY(`taskId`)
);
--> statement-breakpoint
INSERT IGNORE INTO `task_grading_settings` (`taskId`, `autoGrade`) SELECT `taskId`, `aiFeedbackToStudent` FROM `task_notification_settings`;
