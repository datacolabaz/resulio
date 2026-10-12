CREATE TABLE IF NOT EXISTS `coach_page_reports` (
	`materialId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`report` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coach_page_reports_materialId` PRIMARY KEY(`materialId`)
);
