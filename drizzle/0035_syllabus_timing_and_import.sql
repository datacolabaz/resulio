CREATE TABLE `syllabus_import_jobs` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`fileId` varchar(32),
	`fileName` varchar(255) NOT NULL DEFAULT '',
	`mimeType` varchar(127) NOT NULL DEFAULT '',
	`sizeBytes` int NOT NULL DEFAULT 0,
	`sourceText` longtext,
	`status` enum('QUEUED','PROCESSING','READY','FAILED','COMPLETED') NOT NULL DEFAULT 'QUEUED',
	`errorCode` varchar(64),
	`pageCount` int,
	`chunkCount` int NOT NULL DEFAULT 0,
	`chunksDone` int NOT NULL DEFAULT 0,
	`inputMode` varchar(16),
	`model` varchar(120),
	`runId` varchar(32),
	`result` json,
	`syllabusId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`finishedAt` timestamp,
	CONSTRAINT `syllabus_import_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_timing` (
	`syllabusId` varchar(32) NOT NULL,
	`timing` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_timing_syllabusId` PRIMARY KEY(`syllabusId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_version_timing` (
	`versionId` varchar(32) NOT NULL,
	`timing` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_version_timing_versionId` PRIMARY KEY(`versionId`)
);
--> statement-breakpoint
CREATE INDEX `syllabus_import_jobs_workspace_idx` ON `syllabus_import_jobs` (`providerWorkspaceId`,`createdAt`);