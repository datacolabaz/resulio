CREATE TABLE `task_quiz_questions` (
	`taskId` varchar(32) NOT NULL,
	`questionId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `task_quiz_questions_taskId_questionId_pk` PRIMARY KEY(`taskId`,`questionId`)
);
--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `quizAnswers` json;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `quizScore` double;--> statement-breakpoint
ALTER TABLE `task_submissions` ADD `quizMaxScore` double;--> statement-breakpoint
CREATE INDEX `task_quiz_questions_task_idx` ON `task_quiz_questions` (`taskId`);