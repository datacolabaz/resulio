-- Makes audit_logs append-only at the database level. Separate ops step, run once after migration 0004.
--
-- Why separate: with binary logging on (Railway/MySQL 8 default), CREATE TRIGGER needs SUPER or
-- log_bin_trust_function_creators=1; the application user normally has neither (ERROR 1419). Run this with
-- the privileged/owner account, never from the app. The application code has no UPDATE/DELETE path for
-- audit_logs either (enforced by a unit test); the triggers also stop manual SQL and compromised app sessions.
--
-- Verify afterwards: `SHOW TRIGGERS LIKE 'audit_logs';` lists both triggers, and
-- `UPDATE audit_logs SET reason = reason LIMIT 1;` fails with "audit_logs is append-only".
-- Retention: a DBA can drop the triggers inside an approved maintenance window, archive, and re-create them.
-- The mysql client needs the DELIMITER lines; drop them when running through a driver.

DROP TRIGGER IF EXISTS `audit_logs_no_update`;
DROP TRIGGER IF EXISTS `audit_logs_no_delete`;

DELIMITER //
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
END//
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
END//
DELIMITER ;
