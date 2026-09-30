-- Reverse of drizzle/0004_admin_console.sql. Preferred rollback is restoring the pre-migration backup;
-- use this only when the 0004 app has served traffic and its writes must be kept.
-- Nothing is lost: the new user/partner/role columns are copied, and the four new tables are renamed to
-- _rollback_0004_*. Review and drop them after the rollback decision is final.
--
-- SECURITY: the pre-0004 app has no account suspension. Any SUSPENDED account regains access after this
-- rollback. Check `SELECT id, email FROM users WHERE accountStatus = 'SUSPENDED'` first and decide how to
-- handle those accounts before running it.
-- Reserved roles (PARTNER_ADMIN, FINANCE_ADMIN, CONTENT_REVIEWER) have no pre-0004 equivalent; their rows are
-- removed from platform_roles and kept in _rollback_0004_platform_roles. INFO_REQUESTED partner profiles
-- return to PENDING; their original status stays in _rollback_0004_partner_profiles.
-- If the append-only triggers were installed, they stay attached to the renamed audit table.

CREATE TABLE `_rollback_0004_users` AS
  SELECT `id`, `accountStatus`, `suspendedAt`, `sessionsValidAfter`, `lastSeenAt` FROM `users`;
CREATE TABLE `_rollback_0004_partner_profiles` AS
  SELECT `id`, `status`, `applicationAnswers`, `decidedBy`, `decidedAt` FROM `partner_profiles`;
CREATE TABLE `_rollback_0004_platform_roles` AS
  SELECT `id`, `userId`, `role`, `createdBy`, `createdAt` FROM `platform_roles`;

ALTER TABLE `platform_roles` MODIFY COLUMN `role` enum('ADMIN','SUPPORT','SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER') NOT NULL;
UPDATE `platform_roles` SET `role` = 'ADMIN' WHERE `role` = 'SUPER_ADMIN';
UPDATE `platform_roles` SET `role` = 'SUPPORT' WHERE `role` = 'SUPPORT_ADMIN';
DELETE FROM `platform_roles` WHERE `role` IN ('PARTNER_ADMIN', 'FINANCE_ADMIN', 'CONTENT_REVIEWER');
ALTER TABLE `platform_roles` MODIFY COLUMN `role` enum('ADMIN','SUPPORT') NOT NULL;
ALTER TABLE `platform_roles` DROP COLUMN `createdBy`;

UPDATE `partner_profiles` SET `status` = 'PENDING' WHERE `status` = 'INFO_REQUESTED';
ALTER TABLE `partner_profiles` MODIFY COLUMN `status` enum('PENDING','APPROVED','REJECTED','SUSPENDED') NOT NULL DEFAULT 'PENDING';
ALTER TABLE `partner_profiles`
  DROP COLUMN `applicationAnswers`,
  DROP COLUMN `decidedBy`,
  DROP COLUMN `decidedAt`;

DROP INDEX `users_account_status_idx` ON `users`;
DROP INDEX `users_last_seen_idx` ON `users`;
ALTER TABLE `users`
  DROP COLUMN `accountStatus`,
  DROP COLUMN `suspendedAt`,
  DROP COLUMN `sessionsValidAfter`,
  DROP COLUMN `lastSeenAt`;

RENAME TABLE
  `audit_logs` TO `_rollback_0004_audit_logs`,
  `security_events` TO `_rollback_0004_security_events`,
  `feature_flags` TO `_rollback_0004_feature_flags`,
  `feature_flag_overrides` TO `_rollback_0004_feature_flag_overrides`;

-- The 0004 journal row (journal "when" = 1790707991583).
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1790707991583;
