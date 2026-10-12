CREATE TABLE IF NOT EXISTS `coach_chunks` (
	`id` varchar(32) NOT NULL,
	`materialId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`topicId` varchar(32),
	`ord` int NOT NULL,
	`pageFrom` int NOT NULL,
	`pageTo` int NOT NULL,
	`heading` varchar(255) NOT NULL DEFAULT '',
	`text` mediumtext NOT NULL,
	`method` varchar(8) NOT NULL DEFAULT 'TEXT',
	`quality` int,
	`edited` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coach_chunks_id` PRIMARY KEY(`id`),
	INDEX `coach_chunks_material_idx` (`materialId`,`ord`),
	INDEX `coach_chunks_topic_idx` (`topicId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coach_materials` (
	`id` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`title` varchar(200) NOT NULL,
	`source` varchar(8) NOT NULL,
	`goal` varchar(16) NOT NULL DEFAULT 'LEARN_ALL',
	`fileId` varchar(32),
	`fileName` varchar(255),
	`mimeType` varchar(120),
	`sizeBytes` int NOT NULL DEFAULT 0,
	`pageCount` int NOT NULL DEFAULT 0,
	`charCount` int NOT NULL DEFAULT 0,
	`status` varchar(12) NOT NULL DEFAULT 'QUEUED',
	`errorCode` varchar(24),
	`runId` varchar(32),
	`ocrPages` int NOT NULL DEFAULT 0,
	`ocrScore` int,
	`needsReview` boolean NOT NULL DEFAULT false,
	`textRevision` int NOT NULL DEFAULT 1,
	`lastOpenedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coach_materials_id` PRIMARY KEY(`id`),
	INDEX `coach_materials_student_idx` (`studentId`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coach_topics` (
	`id` varchar(32) NOT NULL,
	`materialId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`ord` int NOT NULL,
	`title` varchar(200) NOT NULL,
	`pageFrom` int NOT NULL DEFAULT 1,
	`pageTo` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coach_topics_id` PRIMARY KEY(`id`),
	INDEX `coach_topics_material_idx` (`materialId`,`ord`),
	INDEX `coach_topics_student_idx` (`studentId`)
);
