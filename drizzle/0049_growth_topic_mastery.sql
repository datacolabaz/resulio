CREATE TABLE `assessment_origins` (
	`assessmentId` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`origin` varchar(16) NOT NULL,
	`topicKeys` json NOT NULL,
	`sourceRef` varchar(64),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assessment_origins_assessmentId` PRIMARY KEY(`assessmentId`)
);
--> statement-breakpoint
CREATE TABLE `growth_dirty` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`reason` varchar(32) NOT NULL,
	`dirtyAt` timestamp(3) NOT NULL,
	CONSTRAINT `growth_dirty_workspaceId_studentId_pk` PRIMARY KEY(`workspaceId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `result_topic_stats` (
	`resultId` varchar(32) NOT NULL,
	`dimension` enum('TOPIC','SKILL') NOT NULL,
	`topicKey` varchar(128) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`origin` varchar(16) NOT NULL,
	`questionTopicId` varchar(32),
	`label` varchar(120) NOT NULL,
	`completedAt` timestamp NOT NULL,
	`questionCount` int NOT NULL,
	`correctCount` int NOT NULL,
	`wrongCount` int NOT NULL,
	`unansweredCount` int NOT NULL,
	`pendingCount` int NOT NULL,
	`earned` double NOT NULL,
	`possible` double NOT NULL,
	`wrongPoints` double NOT NULL,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `result_topic_stats_resultId_dimension_topicKey_pk` PRIMARY KEY(`resultId`,`dimension`,`topicKey`)
);
--> statement-breakpoint
CREATE TABLE `student_topic_mastery` (
	`workspaceId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`dimension` enum('TOPIC','SKILL') NOT NULL,
	`topicKey` varchar(128) NOT NULL,
	`questionTopicId` varchar(32),
	`label` varchar(120) NOT NULL,
	`mastery` double NOT NULL,
	`rawPct` double NOT NULL,
	`evidenceCount` int NOT NULL,
	`examCount` int NOT NULL,
	`trend` varchar(8) NOT NULL,
	`trendDelta` double,
	`status` varchar(16) NOT NULL,
	`lastEvidenceAt` timestamp NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `student_topic_mastery_workspaceId_studentId_dimension_topicKey_pk` PRIMARY KEY(`workspaceId`,`studentId`,`dimension`,`topicKey`)
);
--> statement-breakpoint
CREATE TABLE `topic_aliases` (
	`workspaceId` varchar(32) NOT NULL,
	`aliasKey` varchar(120) NOT NULL,
	`label` varchar(120) NOT NULL,
	`questionTopicId` varchar(32),
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `topic_aliases_workspaceId_aliasKey_pk` PRIMARY KEY(`workspaceId`,`aliasKey`)
);
--> statement-breakpoint
CREATE INDEX `assessment_origins_student_idx` ON `assessment_origins` (`workspaceId`,`studentId`,`origin`);--> statement-breakpoint
CREATE INDEX `growth_dirty_at_idx` ON `growth_dirty` (`dirtyAt`);--> statement-breakpoint
CREATE INDEX `result_topic_stats_student_idx` ON `result_topic_stats` (`workspaceId`,`studentId`,`completedAt`);--> statement-breakpoint
CREATE INDEX `result_topic_stats_topic_idx` ON `result_topic_stats` (`workspaceId`,`dimension`,`topicKey`);--> statement-breakpoint
CREATE INDEX `student_topic_mastery_topic_idx` ON `student_topic_mastery` (`workspaceId`,`dimension`,`topicKey`);--> statement-breakpoint
CREATE INDEX `student_topic_mastery_student_idx` ON `student_topic_mastery` (`studentId`);