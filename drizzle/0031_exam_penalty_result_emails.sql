CREATE TABLE `result_email_log` (
	`resultId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `result_email_log_resultId` PRIMARY KEY(`resultId`)
);
--> statement-breakpoint
CREATE TABLE `result_penalties` (
	`resultId` varchar(32) NOT NULL,
	`ratio` int NOT NULL,
	`wrongCount` int NOT NULL,
	`closedEarned` double NOT NULL,
	`penaltyPoints` double NOT NULL,
	CONSTRAINT `result_penalties_resultId` PRIMARY KEY(`resultId`)
);
