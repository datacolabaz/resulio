CREATE TABLE `question_import_items` (
	`id` varchar(32) NOT NULL,
	`jobId` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`status` enum('PENDING','ACCEPTED','REJECTED') NOT NULL DEFAULT 'PENDING',
	`question` json NOT NULL,
	`issues` json NOT NULL,
	`sectionId` varchar(32) NOT NULL,
	`suggestedSectionId` varchar(32),
	`suggestedSection` varchar(120),
	`answerSource` enum('SOURCE','AI','TEACHER') NOT NULL,
	`confidence` enum('LOW','MEDIUM','HIGH') NOT NULL,
	`sourcePage` int,
	`sourceNumber` varchar(32),
	`duplicateOfQuestionId` varchar(32),
	`questionId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `question_import_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `question_import_jobs` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`fileId` varchar(32) NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`mimeType` varchar(127) NOT NULL,
	`sizeBytes` int NOT NULL,
	`status` enum('QUEUED','PROCESSING','READY','FAILED','COMPLETED') NOT NULL DEFAULT 'QUEUED',
	`errorCode` varchar(64),
	`sectionId` varchar(32) NOT NULL,
	`pageCount` int,
	`chunkCount` int NOT NULL DEFAULT 0,
	`chunksDone` int NOT NULL DEFAULT 0,
	`inputMode` varchar(16),
	`model` varchar(120),
	`runId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`finishedAt` timestamp,
	CONSTRAINT `question_import_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `question_meta` (
	`questionId` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`sectionId` varchar(32),
	`bankNumber` int,
	`importJobId` varchar(32),
	`sourceFileName` varchar(255),
	`sourcePage` int,
	`sourceNumber` varchar(32),
	`answerSource` enum('SOURCE','AI','TEACHER'),
	`aiConfidence` enum('LOW','MEDIUM','HIGH'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `question_meta_questionId` PRIMARY KEY(`questionId`),
	CONSTRAINT `question_meta_number_unique` UNIQUE(`sectionId`,`bankNumber`)
);
--> statement-breakpoint
CREATE TABLE `question_topics` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`parentId` varchar(32),
	`parentKey` varchar(32) NOT NULL DEFAULT '',
	`name` varchar(120) NOT NULL,
	`nameKey` varchar(120) NOT NULL,
	`syllabusId` varchar(32),
	`syllabusModuleId` varchar(32),
	`nextNumber` int NOT NULL DEFAULT 1,
	`position` int NOT NULL DEFAULT 0,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `question_topics_id` PRIMARY KEY(`id`),
	CONSTRAINT `question_topics_name_unique` UNIQUE(`providerWorkspaceId`,`parentKey`,`nameKey`)
);
--> statement-breakpoint
CREATE INDEX `question_import_items_job_idx` ON `question_import_items` (`jobId`,`position`);--> statement-breakpoint
CREATE INDEX `question_import_jobs_workspace_idx` ON `question_import_jobs` (`providerWorkspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `question_meta_section_idx` ON `question_meta` (`providerWorkspaceId`,`sectionId`);--> statement-breakpoint
CREATE INDEX `question_meta_job_idx` ON `question_meta` (`importJobId`);