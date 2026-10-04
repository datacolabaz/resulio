CREATE TABLE `group_learning_settings` (
	`groupId` varchar(32) NOT NULL,
	`progressVisibleToGroup` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `group_learning_settings_groupId` PRIMARY KEY(`groupId`)
);
--> statement-breakpoint
CREATE TABLE `syllabi` (
	`id` varchar(32) NOT NULL,
	`providerWorkspaceId` varchar(32) NOT NULL,
	`createdBy` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`subject` varchar(120) NOT NULL DEFAULT '',
	`level` varchar(64) NOT NULL DEFAULT '',
	`language` varchar(64) NOT NULL DEFAULT '',
	`coverFileId` varchar(32),
	`estimatedDurationLabel` varchar(64) NOT NULL DEFAULT '',
	`estimatedHours` int,
	`status` enum('DRAFT','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`completionRules` json NOT NULL,
	`currentVersionId` varchar(32),
	`hasDraftChanges` boolean NOT NULL DEFAULT true,
	`draftRevision` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`archivedAt` timestamp,
	CONSTRAINT `syllabi_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_access_grants` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`groupId` varchar(32),
	`studentId` int,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`startsAt` timestamp,
	`endsAt` timestamp,
	`note` varchar(255),
	`grantedBy` int NOT NULL,
	`grantedAt` timestamp NOT NULL DEFAULT (now()),
	`revokedBy` int,
	`revokedAt` timestamp,
	CONSTRAINT `syllabus_access_grants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_approvals` (
	`id` varchar(32) NOT NULL,
	`enrollmentId` varchar(32) NOT NULL,
	`targetType` enum('LESSON','MODULE','SYLLABUS') NOT NULL,
	`targetId` varchar(32) NOT NULL,
	`decision` enum('APPROVED','RETURNED') NOT NULL,
	`note` varchar(500),
	`decidedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_assessment_assignments` (
	`assignmentId` int NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`enrollmentId` varchar(32) NOT NULL,
	`itemId` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_assessment_assignments_assignmentId` PRIMARY KEY(`assignmentId`),
	CONSTRAINT `syllabus_assessment_assignments_item_unique` UNIQUE(`enrollmentId`,`itemId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_completions` (
	`id` varchar(32) NOT NULL,
	`enrollmentId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`completedAt` timestamp NOT NULL,
	`overallPct` double NOT NULL,
	`finalAssessmentPct` double,
	`verificationCode` varchar(24) NOT NULL,
	`certificateNo` varchar(32),
	`certificateIssuedAt` timestamp,
	`snapshot` json NOT NULL,
	`revokedAt` timestamp,
	`revokedBy` int,
	`revokeReason` varchar(500),
	CONSTRAINT `syllabus_completions_id` PRIMARY KEY(`id`),
	CONSTRAINT `syllabus_completions_enrollmentId_unique` UNIQUE(`enrollmentId`),
	CONSTRAINT `syllabus_completions_verificationCode_unique` UNIQUE(`verificationCode`),
	CONSTRAINT `syllabus_completions_certificateNo_unique` UNIQUE(`certificateNo`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_enrollments` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`versionId` varchar(32) NOT NULL,
	`status` enum('ACTIVE','COMPLETED') NOT NULL DEFAULT 'ACTIVE',
	`enrolledAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`progressPct` double NOT NULL DEFAULT 0,
	`completedLessons` int NOT NULL DEFAULT 0,
	`totalLessons` int NOT NULL DEFAULT 0,
	`currentModuleId` varchar(32),
	`currentLessonId` varchar(32),
	`lastCompletedLessonId` varchar(32),
	`lastCompletedItemId` varchar(32),
	`lastActivityAt` timestamp,
	`viaGroupId` varchar(32),
	`upgradedFromVersionId` varchar(32),
	`dirtyAt` timestamp,
	`stateRevision` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_enrollments_id` PRIMARY KEY(`id`),
	CONSTRAINT `syllabus_enrollments_unique` UNIQUE(`syllabusId`,`studentId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_item_progress` (
	`enrollmentId` varchar(32) NOT NULL,
	`itemId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`lessonId` varchar(32),
	`kind` enum('THEORY','TEACHER_PRACTICE','STUDENT_PRACTICE','ASSESSMENT','RESOURCE') NOT NULL,
	`openedAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`teacherMarkedAt` timestamp,
	`teacherMarkedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_item_progress_enrollmentId_itemId_pk` PRIMARY KEY(`enrollmentId`,`itemId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_items` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`scope` enum('LESSON','MODULE','SYLLABUS') NOT NULL DEFAULT 'LESSON',
	`moduleId` varchar(32),
	`lessonId` varchar(32),
	`kind` enum('THEORY','TEACHER_PRACTICE','STUDENT_PRACTICE','ASSESSMENT','RESOURCE') NOT NULL,
	`position` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`required` boolean NOT NULL DEFAULT true,
	`content` json NOT NULL,
	`assessmentId` varchar(32),
	`materialId` varchar(32),
	`taskId` varchar(32),
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_lesson_progress` (
	`enrollmentId` varchar(32) NOT NULL,
	`lessonId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`moduleId` varchar(32) NOT NULL,
	`status` enum('LOCKED','AVAILABLE','IN_PROGRESS','AWAITING_REVIEW','AWAITING_APPROVAL','COMPLETED') NOT NULL DEFAULT 'LOCKED',
	`unlockedAt` timestamp,
	`unlockSource` enum('FIRST','SEQUENTIAL','MANUAL','GRANDFATHERED'),
	`openedAt` timestamp,
	`startedAt` timestamp,
	`theoryCompletedAt` timestamp,
	`completedAt` timestamp,
	`activeSeconds` int NOT NULL DEFAULT 0,
	`requirements` json,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_lesson_progress_enrollmentId_lessonId_pk` PRIMARY KEY(`enrollmentId`,`lessonId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_lessons` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`moduleId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`estimatedMinutes` int,
	`objectives` json NOT NULL,
	`status` enum('DRAFT','READY') NOT NULL DEFAULT 'READY',
	`completionRules` json,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_lessons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_manual_unlocks` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`enrollmentId` varchar(32) NOT NULL,
	`studentId` int NOT NULL,
	`targetType` enum('MODULE','LESSON') NOT NULL,
	`targetId` varchar(32) NOT NULL,
	`reason` text NOT NULL,
	`unlockedBy` int NOT NULL,
	`actorKind` enum('TEACHER','ADMIN') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	`revokedBy` int,
	CONSTRAINT `syllabus_manual_unlocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_module_progress` (
	`enrollmentId` varchar(32) NOT NULL,
	`moduleId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`status` enum('LOCKED','AVAILABLE','IN_PROGRESS','AWAITING_APPROVAL','COMPLETED') NOT NULL DEFAULT 'LOCKED',
	`unlockedAt` timestamp,
	`unlockSource` enum('FIRST','SEQUENTIAL','MANUAL','GRANDFATHERED'),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`completedLessons` int NOT NULL DEFAULT 0,
	`totalLessons` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_module_progress_enrollmentId_moduleId_pk` PRIMARY KEY(`enrollmentId`,`moduleId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_modules` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`estimatedMinutes` int,
	`objectives` json NOT NULL,
	`prerequisitesText` text,
	`status` enum('DRAFT','READY') NOT NULL DEFAULT 'READY',
	`completionRules` json,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `syllabus_modules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_practice_tasks` (
	`taskId` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`itemId` varchar(32) NOT NULL,
	`versionId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_practice_tasks_taskId` PRIMARY KEY(`taskId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_version_items` (
	`versionId` varchar(32) NOT NULL,
	`itemId` varchar(32) NOT NULL,
	`moduleId` varchar(32),
	`lessonId` varchar(32),
	`kind` enum('THEORY','TEACHER_PRACTICE','STUDENT_PRACTICE','ASSESSMENT','RESOURCE') NOT NULL,
	`content` json NOT NULL,
	`taskId` varchar(32),
	`assessmentId` varchar(32),
	`assessmentVersionId` varchar(32),
	`materialSnapshot` json,
	`contentHash` varchar(64) NOT NULL,
	CONSTRAINT `syllabus_version_items_versionId_itemId_pk` PRIMARY KEY(`versionId`,`itemId`)
);
--> statement-breakpoint
CREATE TABLE `syllabus_versions` (
	`id` varchar(32) NOT NULL,
	`syllabusId` varchar(32) NOT NULL,
	`versionNo` int NOT NULL,
	`label` varchar(16) NOT NULL,
	`status` enum('PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'PUBLISHED',
	`structure` json NOT NULL,
	`meta` json NOT NULL,
	`changeNote` text,
	`publishedBy` int NOT NULL,
	`publishedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `syllabus_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `syllabus_versions_no_unique` UNIQUE(`syllabusId`,`versionNo`)
);
--> statement-breakpoint
CREATE INDEX `syllabi_workspace_idx` ON `syllabi` (`providerWorkspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_grants_syllabus_idx` ON `syllabus_access_grants` (`syllabusId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_grants_group_idx` ON `syllabus_access_grants` (`groupId`);--> statement-breakpoint
CREATE INDEX `syllabus_grants_student_idx` ON `syllabus_access_grants` (`studentId`);--> statement-breakpoint
CREATE INDEX `syllabus_approvals_target_idx` ON `syllabus_approvals` (`enrollmentId`,`targetType`,`targetId`);--> statement-breakpoint
CREATE INDEX `syllabus_completions_syllabus_idx` ON `syllabus_completions` (`syllabusId`,`completedAt`);--> statement-breakpoint
CREATE INDEX `syllabus_enrollments_activity_idx` ON `syllabus_enrollments` (`syllabusId`,`lastActivityAt`);--> statement-breakpoint
CREATE INDEX `syllabus_enrollments_student_idx` ON `syllabus_enrollments` (`studentId`);--> statement-breakpoint
CREATE INDEX `syllabus_enrollments_dirty_idx` ON `syllabus_enrollments` (`dirtyAt`);--> statement-breakpoint
CREATE INDEX `syllabus_item_progress_idx` ON `syllabus_item_progress` (`syllabusId`,`itemId`);--> statement-breakpoint
CREATE INDEX `syllabus_items_lesson_idx` ON `syllabus_items` (`lessonId`,`kind`,`position`);--> statement-breakpoint
CREATE INDEX `syllabus_items_syllabus_idx` ON `syllabus_items` (`syllabusId`,`scope`);--> statement-breakpoint
CREATE INDEX `syllabus_lesson_progress_idx` ON `syllabus_lesson_progress` (`syllabusId`,`lessonId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_lessons_module_idx` ON `syllabus_lessons` (`moduleId`,`position`);--> statement-breakpoint
CREATE INDEX `syllabus_lessons_syllabus_idx` ON `syllabus_lessons` (`syllabusId`);--> statement-breakpoint
CREATE INDEX `syllabus_unlocks_enrollment_idx` ON `syllabus_manual_unlocks` (`enrollmentId`);--> statement-breakpoint
CREATE INDEX `syllabus_unlocks_syllabus_idx` ON `syllabus_manual_unlocks` (`syllabusId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `syllabus_module_progress_idx` ON `syllabus_module_progress` (`syllabusId`,`moduleId`,`status`);--> statement-breakpoint
CREATE INDEX `syllabus_modules_syllabus_idx` ON `syllabus_modules` (`syllabusId`,`position`);--> statement-breakpoint
CREATE INDEX `syllabus_practice_tasks_item_idx` ON `syllabus_practice_tasks` (`syllabusId`,`itemId`);--> statement-breakpoint
CREATE INDEX `syllabus_version_items_lesson_idx` ON `syllabus_version_items` (`versionId`,`lessonId`);