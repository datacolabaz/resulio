CREATE TABLE `grade_email_log` (
	`submissionId` varchar(32) NOT NULL,
	`score` double,
	`sentAt` timestamp NOT NULL,
	CONSTRAINT `grade_email_log_submissionId` PRIMARY KEY(`submissionId`)
);
--> statement-breakpoint
CREATE TABLE `notification_dedupe` (
	`userId` int NOT NULL,
	`dedupeKey` varchar(120) NOT NULL,
	`lastSentAt` timestamp NOT NULL,
	CONSTRAINT `notification_dedupe_userId_dedupeKey_pk` PRIMARY KEY(`userId`,`dedupeKey`)
);
