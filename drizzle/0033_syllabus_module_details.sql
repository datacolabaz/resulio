CREATE TABLE `syllabus_module_details` (
	`moduleId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`details` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_module_details_moduleId` PRIMARY KEY(`moduleId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_version_module_details` (
	`versionId` varchar(32) NOT NULL,
	`moduleId` varchar(32) NOT NULL,
	`details` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_version_module_details_versionId_moduleId_pk` PRIMARY KEY(`versionId`,`moduleId`)
);
--> statement-breakpoint
CREATE INDEX `syllabus_module_details_syllabus_idx` ON `syllabus_module_details` (`syllabusId`);