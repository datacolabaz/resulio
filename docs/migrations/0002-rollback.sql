-- Reverse of drizzle/0002_assessment_engine.sql (runbook section F2). Run 0003-rollback.sql first if 0003
-- was applied. Preferred rollback is restoring the pre-migration backup (F1).
-- Everything created in the new tables is not representable in the old schema: export it first
-- (mysqldump --no-create-info <db> <tables>), then decide. Legacy roles are restored from
-- _legacy_user_roles_0002.

ALTER TABLE `users` ADD `role` enum('user','admin') NOT NULL DEFAULT 'user';
ALTER TABLE `users` ADD `appRole` enum('TEACHER','STUDENT');
UPDATE `users` u JOIN `_legacy_user_roles_0002` l ON l.userId = u.id SET u.role = l.role, u.appRole = l.appRole;
-- Users created after go-live: admins and workspace owners get their closest legacy equivalent.
UPDATE `users` u JOIN `platform_roles` p ON p.userId = u.id AND p.role = 'ADMIN' SET u.role = 'admin';
UPDATE `users` u JOIN `provider_workspaces` w ON w.ownerUserId = u.id SET u.appRole = 'TEACHER'
  WHERE u.appRole IS NULL;

DROP TABLE `result_items`, `results`, `student_answers`, `attempts`, `version_questions`,
  `assessment_versions`, `assessment_assignments`, `assessment_questions`, `assessments`, `questions`,
  `group_members`, `study_groups`, `platform_roles`, `partner_profiles`, `provider_workspaces`, `auth_accounts`;
ALTER TABLE `users` DROP COLUMN `avatarUrl`;
ALTER TABLE `users` DROP COLUMN `lastActiveContext`;
-- The 0002 journal row (journal "when" = 1788785600000).
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1788785600000;
DROP TABLE `_legacy_user_roles_0002`;
