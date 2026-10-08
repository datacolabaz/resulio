CREATE TABLE `syllabus_data_backfills` (
	`name` varchar(64) NOT NULL,
	`summary` text,
	`ranAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_data_backfills_name` PRIMARY KEY(`name`)
);
