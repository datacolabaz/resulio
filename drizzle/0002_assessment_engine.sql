ALTER TABLE `users` ADD `avatarUrl` text;--> statement-breakpoint
ALTER TABLE `users` ADD `lastActiveContext` enum('learning','teaching','partner');--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`provider` varchar(32) NOT NULL,
	`providerAccountId` varchar(191) NOT NULL,
	`providerEmail` varchar(320),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auth_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_accounts_provider_account_unique` UNIQUE(`provider`,`providerAccountId`)
);
--> statement-breakpoint
CREATE INDEX `auth_accounts_user_idx` ON `auth_accounts` (`userId`);--> statement-breakpoint
CREATE TABLE `provider_workspaces` (
	`id` varchar(32) NOT NULL,
	`ownerUserId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`publicDisplayName` varchar(255) NOT NULL DEFAULT '',
	`providerType` enum('TEACHER','TRAINER','CENTER','SCHOOL') NOT NULL DEFAULT 'TEACHER',
	`subscriptionStatus` enum('BETA','TRIAL','ACTIVE','PAST_DUE','CANCELED') NOT NULL DEFAULT 'BETA',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `provider_workspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `provider_workspaces_owner_idx` ON `provider_workspaces` (`ownerUserId`);--> statement-breakpoint
CREATE TABLE `partner_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`status` enum('PENDING','APPROVED','REJECTED','SUSPENDED') NOT NULL DEFAULT 'PENDING',
	`referralCode` varchar(32) NOT NULL,
	`approvedAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `partner_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `partner_profiles_userId_unique` UNIQUE(`userId`),
	CONSTRAINT `partner_profiles_referralCode_unique` UNIQUE(`referralCode`)
);
--> statement-breakpoint
CREATE TABLE `platform_roles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`role` enum('ADMIN','SUPPORT') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_roles_user_role_unique` UNIQUE(`userId`,`role`)
);
--> statement-breakpoint
CREATE TABLE `_legacy_user_roles_0002` (
	`userId` int NOT NULL,
	`role` varchar(16),
	`appRole` varchar(16),
	`copiedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `_legacy_user_roles_0002_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
INSERT INTO `_legacy_user_roles_0002` (`userId`, `role`, `appRole`) SELECT `id`, `role`, `appRole` FROM `users`;--> statement-breakpoint
INSERT INTO `platform_roles` (`userId`, `role`) SELECT `id`, 'ADMIN' FROM `users` WHERE `role` = 'admin';--> statement-breakpoint
INSERT INTO `provider_workspaces` (`id`, `ownerUserId`, `title`, `publicDisplayName`) SELECT CONCAT('ws_legacy_', `id`), `id`, LEFT(COALESCE(NULLIF(`name`, ''), `email`, 'Tədris məkanı'), 255), LEFT(COALESCE(`name`, ''), 255) FROM `users` WHERE `appRole` = 'TEACHER';--> statement-breakpoint
UPDATE `users` SET `lastActiveContext` = 'teaching' WHERE `appRole` = 'TEACHER';--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `role`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `appRole`;--> statement-breakpoint
CREATE TABLE `study_groups` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`name` varchar(255) NOT NULL,
	`subject` varchar(120) NOT NULL DEFAULT '',
	`grade` varchar(32) NOT NULL DEFAULT '',
	`description` text,
	`inviteCode` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `study_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `study_groups_inviteCode_unique` UNIQUE(`inviteCode`)
);
--> statement-breakpoint
CREATE INDEX `groups_workspace_idx` ON `study_groups` (`providerWorkspaceId`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`groupId` varchar(32) NOT NULL,
	`userId` int NOT NULL,
	`membershipRole` enum('STUDENT') NOT NULL DEFAULT 'STUDENT',
	`status` enum('PENDING','ACTIVE') NOT NULL DEFAULT 'PENDING',
	`joinedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `group_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `group_members_group_user_unique` UNIQUE(`groupId`,`userId`)
);
--> statement-breakpoint
CREATE INDEX `group_members_user_idx` ON `group_members` (`userId`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`type` varchar(32) NOT NULL,
	`text` text NOT NULL,
	`points` double NOT NULL DEFAULT 1,
	`difficulty` enum('EASY','MEDIUM','HARD') NOT NULL DEFAULT 'MEDIUM',
	`topic` varchar(120) NOT NULL DEFAULT '',
	`skill` varchar(120) NOT NULL DEFAULT '',
	`tags` json NOT NULL,
	`explanation` text,
	`imageUrl` text,
	`content` json NOT NULL,
	`answerKey` json NOT NULL,
	`source` enum('MANUAL','AI') NOT NULL DEFAULT 'MANUAL',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `questions_workspace_idx` ON `questions` (`providerWorkspaceId`);--> statement-breakpoint
CREATE INDEX `questions_topic_idx` ON `questions` (`providerWorkspaceId`,`topic`);--> statement-breakpoint
CREATE TABLE `assessments` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`type` enum('EXAM','KSQ','BSQ') NOT NULL,
	`status` enum('DRAFT','PUBLISHED','CLOSED') NOT NULL DEFAULT 'DRAFT',
	`settings` json NOT NULL,
	`startAt` timestamp NULL,
	`endAt` timestamp NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Baku',
	`shareCode` varchar(16) NOT NULL,
	`currentVersionId` varchar(32),
	`hasDraftChanges` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assessments_id` PRIMARY KEY(`id`),
	CONSTRAINT `assessments_shareCode_unique` UNIQUE(`shareCode`)
);
--> statement-breakpoint
CREATE INDEX `assessments_workspace_idx` ON `assessments` (`providerWorkspaceId`,`type`);--> statement-breakpoint
CREATE TABLE `assessment_questions` (
	`assessmentId` varchar(32) NOT NULL,
	`questionId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `assessment_questions_assessmentId_questionId_pk` PRIMARY KEY(`assessmentId`,`questionId`)
);
--> statement-breakpoint
CREATE TABLE `assessment_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`assessmentVersionId` varchar(32),
	`groupId` varchar(32),
	`studentId` int,
	`availableFrom` timestamp NULL,
	`availableUntil` timestamp NULL,
	`durationOverrideSeconds` int,
	`attemptLimitOverride` int,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`assignedBy` int NOT NULL,
	`assignedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assessment_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `assessment_assignments_assessment_idx` ON `assessment_assignments` (`assessmentId`);--> statement-breakpoint
CREATE INDEX `assessment_assignments_group_idx` ON `assessment_assignments` (`groupId`);--> statement-breakpoint
CREATE INDEX `assessment_assignments_student_idx` ON `assessment_assignments` (`studentId`);--> statement-breakpoint
CREATE TABLE `assessment_versions` (
	`id` varchar(32) NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`versionNo` int NOT NULL,
	`status` enum('PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'PUBLISHED',
	`settings` json NOT NULL,
	`publishedBy` int NOT NULL,
	`publishedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assessment_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `assessment_versions_no_unique` UNIQUE(`assessmentId`,`versionNo`)
);
--> statement-breakpoint
CREATE TABLE `version_questions` (
	`id` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`sourceQuestionId` varchar(32),
	`position` int NOT NULL,
	`type` varchar(32) NOT NULL,
	`text` text NOT NULL,
	`points` double NOT NULL,
	`difficulty` enum('EASY','MEDIUM','HARD') NOT NULL,
	`topic` varchar(120) NOT NULL DEFAULT '',
	`skill` varchar(120) NOT NULL DEFAULT '',
	`explanation` text,
	`imageUrl` text,
	`content` json NOT NULL,
	`answerKey` json NOT NULL,
	CONSTRAINT `version_questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `version_questions_version_idx` ON `version_questions` (`versionId`,`position`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` varchar(32) NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`assignmentId` int NOT NULL,
	`studentId` int NOT NULL,
	`attemptNo` int NOT NULL,
	`status` enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED') NOT NULL DEFAULT 'IN_PROGRESS',
	`questionOrder` json NOT NULL,
	`startedAt` timestamp NOT NULL,
	`deadlineAt` timestamp NOT NULL,
	`submittedAt` timestamp NULL,
	CONSTRAINT `attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `attempts_student_no_unique` UNIQUE(`assessmentId`,`studentId`,`attemptNo`)
);
--> statement-breakpoint
CREATE INDEX `attempts_status_deadline_idx` ON `attempts` (`status`,`deadlineAt`);--> statement-breakpoint
CREATE INDEX `attempts_student_idx` ON `attempts` (`studentId`);--> statement-breakpoint
CREATE TABLE `student_answers` (
	`attemptId` varchar(32) NOT NULL,
	`versionQuestionId` varchar(32) NOT NULL,
	`answer` json,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `student_answers_attemptId_versionQuestionId_pk` PRIMARY KEY(`attemptId`,`versionQuestionId`)
);
--> statement-breakpoint
CREATE TABLE `results` (
	`id` varchar(32) NOT NULL,
	`attemptId` varchar(32) NOT NULL,
	`assessmentId` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`totalPoints` double NOT NULL,
	`earnedPoints` double NOT NULL,
	`percentage` double NOT NULL,
	`correctCount` int NOT NULL,
	`wrongCount` int NOT NULL,
	`unansweredCount` int NOT NULL,
	`pendingReviewCount` int NOT NULL DEFAULT 0,
	`durationSeconds` int NOT NULL,
	`completedAt` timestamp NOT NULL,
	CONSTRAINT `results_id` PRIMARY KEY(`id`),
	CONSTRAINT `results_attemptId_unique` UNIQUE(`attemptId`)
);
--> statement-breakpoint
CREATE INDEX `results_assessment_idx` ON `results` (`assessmentId`);--> statement-breakpoint
CREATE INDEX `results_student_idx` ON `results` (`studentId`);--> statement-breakpoint
CREATE TABLE `result_items` (
	`resultId` varchar(32) NOT NULL,
	`versionQuestionId` varchar(32) NOT NULL,
	`status` enum('CORRECT','WRONG','UNANSWERED','PENDING_REVIEW') NOT NULL,
	`earned` double NOT NULL,
	`topic` varchar(120) NOT NULL DEFAULT '',
	`skill` varchar(120) NOT NULL DEFAULT '',
	CONSTRAINT `result_items_resultId_versionQuestionId_pk` PRIMARY KEY(`resultId`,`versionQuestionId`)
);
--> statement-breakpoint
CREATE INDEX `result_items_question_idx` ON `result_items` (`versionQuestionId`);
