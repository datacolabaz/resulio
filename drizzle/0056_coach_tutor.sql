CREATE TABLE IF NOT EXISTS `coach_messages` (
	`id` varchar(32) NOT NULL,
	`threadId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`role` varchar(12) NOT NULL,
	`action` varchar(12),
	`mode` varchar(12),
	`content` text NOT NULL,
	`cites` json,
	`grounding` varchar(12),
	`recall` varchar(600),
	`model` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coach_messages_id` PRIMARY KEY(`id`),
	INDEX `coach_messages_thread_idx` (`threadId`,`createdAt`),
	INDEX `coach_messages_student_idx` (`studentId`,`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coach_threads` (
	`id` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`materialId` varchar(32) NOT NULL,
	`topicId` varchar(32),
	`title` varchar(200) NOT NULL,
	`messageCount` int NOT NULL DEFAULT 0,
	`lastMessageAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coach_threads_id` PRIMARY KEY(`id`),
	INDEX `coach_threads_student_idx` (`studentId`,`lastMessageAt`),
	INDEX `coach_threads_material_idx` (`materialId`),
	INDEX `coach_threads_topic_idx` (`topicId`)
);
