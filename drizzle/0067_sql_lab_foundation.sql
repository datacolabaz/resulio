CREATE TABLE `sql_lab_configs` (
	`id` varchar(32) NOT NULL,
	`taskId` varchar(32) NOT NULL,
	`datasetFileId` varchar(32) NOT NULL,
	`datasetColumns` json NOT NULL,
	`referenceQuery` text NOT NULL,
	`gradeMode` enum('EXACT_ORDERED','EXACT_UNORDERED','ROW_COUNT_ONLY') NOT NULL DEFAULT 'EXACT_UNORDERED',
	`expectedColumns` json NOT NULL,
	`expectedRows` json NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sql_lab_configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `sql_lab_configs_taskId_unique` UNIQUE(`taskId`)
);
--> statement-breakpoint
CREATE TABLE `sql_lab_submissions` (
	`id` varchar(32) NOT NULL,
	`submissionId` varchar(32) NOT NULL,
	`taskId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`queryText` text NOT NULL,
	`status` enum('CORRECT','WRONG','ERROR','PENDING_REVIEW') NOT NULL,
	`resultColumns` json,
	`resultRowsPreview` json,
	`resultRowCount` int,
	`errorMessage` text,
	`autoScore` double,
	`executionMs` int NOT NULL,
	`serverExecutedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sql_lab_submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sql_lab_submissions_submissionId_unique` UNIQUE(`submissionId`)
);
--> statement-breakpoint
CREATE INDEX `sql_lab_configs_task_idx` ON `sql_lab_configs` (`taskId`);--> statement-breakpoint
CREATE INDEX `sql_lab_submissions_task_idx` ON `sql_lab_submissions` (`taskId`);