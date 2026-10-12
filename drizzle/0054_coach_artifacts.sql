CREATE TABLE IF NOT EXISTS `coach_artifacts` (
	`id` varchar(32) NOT NULL,
	`materialId` varchar(32) NOT NULL,
	`topicId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`kind` varchar(20) NOT NULL,
	`locale` varchar(2) NOT NULL,
	`inputHash` varchar(64) NOT NULL,
	`content` json NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`edited` boolean NOT NULL DEFAULT false,
	`model` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coach_artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `coach_artifacts_topic_kind_uq` UNIQUE(`topicId`,`kind`,`locale`),
	INDEX `coach_artifacts_material_idx` (`materialId`)
);
