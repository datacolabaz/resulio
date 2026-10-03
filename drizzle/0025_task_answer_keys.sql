CREATE TABLE `task_answer_keys` (
	`taskId` varchar(32) NOT NULL,
	`answerKey` text,
	`source` enum('TEACHER','AI_DRAFT') NOT NULL,
	`draftStatus` enum('GENERATING','READY','FAILED'),
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `task_answer_keys_taskId` PRIMARY KEY(`taskId`)
);
