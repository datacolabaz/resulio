CREATE TABLE `group_profiles` (
	`groupId` varchar(32) NOT NULL,
	`groupType` enum('SCHOOL','COURSE') NOT NULL,
	`level` varchar(64) NOT NULL DEFAULT '',
	`source` varchar(32) NOT NULL DEFAULT 'TEACHER',
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `group_profiles_groupId` PRIMARY KEY(`groupId`)
);
