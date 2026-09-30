-- Reverse of drizzle/0003_activity_tracking.sql. Preferred rollback is restoring the pre-migration backup;
-- use this only when the 0003 app has served traffic and its writes must be kept.
-- Nothing is dropped: per-attempt activity columns and answer revisions are copied, and the two new tables
-- are renamed to _rollback_0003_*. Review and drop them after the rollback decision is final.
-- Rows with statuses the old code does not know (EXPIRED_NO_ANSWERS, VOIDED) become AUTO_SUBMITTED; their
-- original status stays in _rollback_0003_attempts. Such attempts have no result row.

CREATE TABLE `_rollback_0003_attempts` AS
  SELECT `id`, `status`, `lastActivityAt`, `lastAutosaveAt`, `lastHeartbeatAt`, `answeredCount`, `totalQuestionCount`,
         `autoSubmittedAt`, `voidedBy`, `voidedAt`
  FROM `attempts`;
CREATE TABLE `_rollback_0003_answer_revisions` AS
  SELECT `attemptId`, `versionQuestionId`, `revision` FROM `student_answers`;
CREATE TABLE `_rollback_0003_inactivity_thresholds` AS
  SELECT `id`, `inactivityThresholdMinutes` FROM `assessments`;

UPDATE `attempts` SET `status` = 'AUTO_SUBMITTED' WHERE `status` IN ('EXPIRED_NO_ANSWERS', 'VOIDED');
ALTER TABLE `attempts` MODIFY COLUMN `status` enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED') NOT NULL DEFAULT 'IN_PROGRESS';
DROP INDEX `attempts_assessment_status_idx` ON `attempts`;
ALTER TABLE `attempts`
  DROP COLUMN `lastActivityAt`,
  DROP COLUMN `lastAutosaveAt`,
  DROP COLUMN `lastHeartbeatAt`,
  DROP COLUMN `answeredCount`,
  DROP COLUMN `totalQuestionCount`,
  DROP COLUMN `autoSubmittedAt`,
  DROP COLUMN `voidedBy`,
  DROP COLUMN `voidedAt`;
ALTER TABLE `student_answers` DROP COLUMN `revision`;
ALTER TABLE `assessments` DROP COLUMN `inactivityThresholdMinutes`;

RENAME TABLE
  `student_activity_events` TO `_rollback_0003_student_activity_events`,
  `assessment_student_progress` TO `_rollback_0003_assessment_student_progress`;

-- The 0003 journal row (journal "when" = 1790701222563).
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1790701222563;
