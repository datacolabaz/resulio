CREATE TABLE `content_meta` (
	`entityType` enum('MATERIAL','TASK') NOT NULL,
	`entityId` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`template` varchar(24) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`status` enum('DRAFT','PUBLISHED') NOT NULL DEFAULT 'PUBLISHED',
	`publishAt` timestamp,
	`visibility` enum('LINK','RECIPIENTS') NOT NULL DEFAULT 'LINK',
	`notify` boolean NOT NULL DEFAULT true,
	`notifiedAt` timestamp,
	`url` varchar(2048),
	`urlHost` varchar(255),
	`dueAt` timestamp,
	`estimatedMinutes` int,
	`subjectKey` varchar(120) NOT NULL DEFAULT '',
	`gradeLevel` varchar(32) NOT NULL DEFAULT '',
	`direction` varchar(64) NOT NULL DEFAULT '',
	`examType` varchar(64) NOT NULL DEFAULT '',
	`skill` varchar(32) NOT NULL DEFAULT '',
	`level` varchar(32) NOT NULL DEFAULT '',
	`difficulty` varchar(16) NOT NULL DEFAULT '',
	`language` varchar(64) NOT NULL DEFAULT '',
	`extra` json NOT NULL,
	`schemaVersion` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `content_meta_entityType_entityId_pk` PRIMARY KEY(`entityType`,`entityId`)
);
--> statement-breakpoint
CREATE TABLE `content_tag_links` (
	`entityType` enum('MATERIAL','TASK') NOT NULL,
	`entityId` varchar(32) NOT NULL,
	`tagId` varchar(32) NOT NULL,
	`position` int NOT NULL DEFAULT 0,
	CONSTRAINT `content_tag_links_entityType_entityId_tagId_pk` PRIMARY KEY(`entityType`,`entityId`,`tagId`)
);
--> statement-breakpoint
CREATE TABLE `content_tags` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`type` enum('TOPIC','TECHNOLOGY') NOT NULL,
	`name` varchar(60) NOT NULL,
	`nameKey` varchar(60) NOT NULL,
	`questionTopicId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `content_tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_tags_key_unique` UNIQUE(`workspaceId`,`type`,`nameKey`)
);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`fileId` varchar(32) NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`mimeType` varchar(127) NOT NULL,
	`sizeBytes` bigint NOT NULL,
	`bucket` varchar(63) NOT NULL,
	`objectKey` varchar(512) NOT NULL,
	`multipartId` varchar(1024),
	`partSize` int,
	`status` enum('PENDING','COMPLETED','ABORTED','EXPIRED') NOT NULL DEFAULT 'PENDING',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `upload_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `content_meta_template_idx` ON `content_meta` (`workspaceId`,`template`);--> statement-breakpoint
CREATE INDEX `content_meta_subject_idx` ON `content_meta` (`workspaceId`,`subjectKey`);--> statement-breakpoint
CREATE INDEX `content_meta_exam_idx` ON `content_meta` (`workspaceId`,`examType`);--> statement-breakpoint
CREATE INDEX `content_meta_skill_idx` ON `content_meta` (`workspaceId`,`skill`);--> statement-breakpoint
CREATE INDEX `content_meta_level_idx` ON `content_meta` (`workspaceId`,`level`);--> statement-breakpoint
CREATE INDEX `content_meta_direction_idx` ON `content_meta` (`workspaceId`,`direction`);--> statement-breakpoint
CREATE INDEX `content_meta_publish_idx` ON `content_meta` (`status`,`publishAt`,`notifiedAt`);--> statement-breakpoint
CREATE INDEX `content_tag_links_tag_idx` ON `content_tag_links` (`tagId`);--> statement-breakpoint
CREATE INDEX `upload_sessions_status_idx` ON `upload_sessions` (`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `upload_sessions_workspace_idx` ON `upload_sessions` (`workspaceId`,`status`);