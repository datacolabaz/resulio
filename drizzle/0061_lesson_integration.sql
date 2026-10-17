CREATE TABLE `lesson_attendance` (
	`id` varchar(32) NOT NULL,
	`lessonId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`joinedAt` timestamp,
	`leftAt` timestamp,
	`durationSec` int,
	`source` enum('JOIN_LINK','PROVIDER_REPORT') NOT NULL DEFAULT 'JOIN_LINK',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lesson_attendance_id` PRIMARY KEY(`id`),
	CONSTRAINT `lesson_attendance_lesson_user_unique` UNIQUE(`lessonId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `lesson_consent_acks` (
	`id` varchar(32) NOT NULL,
	`lessonId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`kind` enum('RECORDING_NOTICE') NOT NULL DEFAULT 'RECORDING_NOTICE',
	`ackedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lesson_consent_acks_id` PRIMARY KEY(`id`),
	CONSTRAINT `lesson_consent_acks_lesson_user_kind_unique` UNIQUE(`lessonId`,`userId`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `lesson_meetings` (
	`lessonId` varchar(32) NOT NULL,
	`connectionId` varchar(32) NOT NULL,
	`provider` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`status` enum('PENDING','CREATED','FAILED') NOT NULL DEFAULT 'PENDING',
	`externalMeetingId` varchar(191),
	`joinUrl` varchar(1024),
	`hostUrl` varchar(1024),
	`passcode` varchar(32),
	`providerCalendarEventId` varchar(191),
	`lastError` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lesson_meetings_lessonId` PRIMARY KEY(`lessonId`)
);
--> statement-breakpoint
CREATE TABLE `lesson_notes` (
	`id` varchar(32) NOT NULL,
	`lessonId` varchar(32) NOT NULL,
	`authorId` int NOT NULL,
	`body` text NOT NULL,
	`visibility` varchar(16) NOT NULL DEFAULT 'SHARED',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lesson_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lesson_records` (
	`id` varchar(32) NOT NULL,
	`lessonId` varchar(32) NOT NULL,
	`kind` enum('TRANSCRIPT','RECORDING','AI_SUMMARY','CHAT_LOG') NOT NULL,
	`sourceProvider` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`captureStatus` enum('PENDING','CAPTURED','FAILED','UNAVAILABLE') NOT NULL DEFAULT 'PENDING',
	`fileId` varchar(32),
	`textContent` longtext,
	`durationSec` int,
	`providerExpiresAt` timestamp,
	`capturedAt` timestamp,
	`lastError` varchar(255),
	`attempts` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lesson_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lesson_series` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`groupIds` json NOT NULL,
	`studentIds` json NOT NULL,
	`platform` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`recurrence` enum('ONCE','WEEKLY','BIWEEKLY') NOT NULL,
	`recurrenceUntil` timestamp,
	`durationMinutes` int NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`joinWindowBeforeMin` int NOT NULL,
	`joinWindowAfterMin` int NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lesson_series_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lesson_webhook_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`provider` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`externalId` varchar(191),
	`lessonId` varchar(32),
	`payload` json NOT NULL,
	`status` enum('RECEIVED','PROCESSED','FAILED','IGNORED') NOT NULL DEFAULT 'RECEIVED',
	`error` varchar(255),
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `lesson_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `lesson_webhook_events_provider_external_unique` UNIQUE(`provider`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` varchar(32) NOT NULL,
	`seriesId` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`groupIds` json NOT NULL,
	`studentIds` json NOT NULL,
	`platform` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`startsAt` timestamp NOT NULL,
	`endsAt` timestamp NOT NULL,
	`status` enum('SCHEDULED','LIVE','ENDED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
	`joinWindowBeforeMin` int NOT NULL,
	`joinWindowAfterMin` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lessons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `teacher_meeting_connections` (
	`id` varchar(32) NOT NULL,
	`workspaceId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`provider` enum('GOOGLE_MEET','ZOOM') NOT NULL,
	`status` enum('ACTIVE','ERROR','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`externalAccountId` varchar(191),
	`accountEmail` varchar(255),
	`scope` varchar(255),
	`accessTokenCipher` text NOT NULL,
	`refreshTokenCipher` text,
	`tokenExpiresAt` timestamp,
	`lastError` varchar(255),
	`connectedAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teacher_meeting_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `teacher_meeting_connections_user_provider_unique` UNIQUE(`userId`,`provider`)
);
--> statement-breakpoint
CREATE INDEX `lesson_meetings_connection_idx` ON `lesson_meetings` (`connectionId`);--> statement-breakpoint
CREATE INDEX `lesson_notes_lesson_idx` ON `lesson_notes` (`lessonId`);--> statement-breakpoint
CREATE INDEX `lesson_records_lesson_kind_idx` ON `lesson_records` (`lessonId`,`kind`);--> statement-breakpoint
CREATE INDEX `lesson_series_workspace_idx` ON `lesson_series` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `lesson_webhook_events_lesson_idx` ON `lesson_webhook_events` (`lessonId`);--> statement-breakpoint
CREATE INDEX `lessons_workspace_startsAt_idx` ON `lessons` (`workspaceId`,`startsAt`);--> statement-breakpoint
CREATE INDEX `lessons_series_idx` ON `lessons` (`seriesId`);--> statement-breakpoint
CREATE INDEX `teacher_meeting_connections_workspace_idx` ON `teacher_meeting_connections` (`workspaceId`);