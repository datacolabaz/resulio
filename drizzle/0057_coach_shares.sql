CREATE TABLE IF NOT EXISTS `coach_shares` (
	`id` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`materialId` varchar(32) NOT NULL,
	`teacherId` int NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coach_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `coach_shares_material_teacher_uq` UNIQUE(`materialId`,`teacherId`),
	INDEX `coach_shares_teacher_idx` (`teacherId`,`workspaceId`),
	INDEX `coach_shares_student_idx` (`studentId`)
);
