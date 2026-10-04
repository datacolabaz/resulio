CREATE TABLE `syllabus_notice_batches` (
	`batchKey` varchar(96) NOT NULL,
	`kind` enum('UNLOCK','APPROVAL') NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`payload` json NOT NULL,
	`revision` int NOT NULL DEFAULT 0,
	`dueAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_notice_batches_batchKey` PRIMARY KEY(`batchKey`)
);
--> statement-breakpoint
CREATE INDEX `syllabus_notice_batches_due_idx` ON `syllabus_notice_batches` (`dueAt`);