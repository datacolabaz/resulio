CREATE TABLE `syllabus_group_listings` (
	`syllabusId` varchar(32) NOT NULL,
	`groupId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_group_listings_syllabusId_groupId_pk` PRIMARY KEY(`syllabusId`,`groupId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_join_requests` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`type` enum('GROUP','INDIVIDUAL') NOT NULL,
	`groupId` varchar(32),
	`message` varchar(1000) NOT NULL DEFAULT '',
	`status` enum('PENDING','ACCEPTED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`openKey` varchar(128),
	`decisionNote` varchar(500),
	`decidedBy` int,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_join_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `syllabus_join_requests_openKey_unique` UNIQUE(`openKey`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_share_links` (
	`syllabusId` varchar(32) NOT NULL,
	`code` varchar(32) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_share_links_syllabusId` PRIMARY KEY(`syllabusId`),
	CONSTRAINT `syllabus_share_links_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE INDEX `syllabus_join_requests_syllabus_idx` ON `syllabus_join_requests` (`syllabusId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_join_requests_workspace_idx` ON `syllabus_join_requests` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_join_requests_student_idx` ON `syllabus_join_requests` (`studentId`);