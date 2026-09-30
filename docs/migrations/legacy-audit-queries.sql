-- =====================================================================================================
-- Resulio legacy data audit + reconciliation query pack (migrations 0002, 0003 and 0004)
-- =====================================================================================================
-- STATUS: PREPARED FOR APPROVAL. NOT RUN ON PRODUCTION.
--
-- Rules
--   * Every query below is read-only (SELECT / SHOW). Nothing here changes data or schema.
--   * Run first on a RESTORED COPY of the production backup (runbook section B), never on the live primary
--     unless the operator explicitly approves each section. Use a read-only database user.
--   * Save every result set (CSV or screenshot) into the migration ticket; the "pre-0003 baseline" results
--     are compared to the "post-0003" results afterwards.
--   * Blocks marked "@template" need operator input (placeholders or external exports) and are never executed
--     by automation. They also need CREATE TEMPORARY TABLES and therefore only run on the restored copy.
--   * appRole = 'TEACHER' is NOT assumed to identify every historical teacher. Section "pre-0002" collects
--     every other available signal (admin role, missing appRole, ownership columns in any table, external
--     billing / AI-usage exports) so the operator can decide per user before migrating.
--
-- Format (machine-readable; scripts/migration-rehearsal.mjs executes every @query block on a disposable DB)
--   -- @section <pre-0002 | post-0002 | pre-0003 | post-0003 | post-0004>
--   -- @query <ID> | <title>
--   -- expect: <expected result on a healthy database>
--   -- risk: <category>  handling: <what to do when the expectation does not hold>
--
-- Risk categories
--   BLOCKER    Do not migrate until resolved (data would be lost, misattributed or unreachable).
--   REVIEW     Migration is safe, but a human decides per row (e.g. who is a teacher).
--   INFO       Recorded for the ticket / reconciliation only.
-- =====================================================================================================


-- =====================================================================================================
-- @section pre-0002
-- Production shape before 0002: only `users` and `__drizzle_migrations`. Run on the restored copy.
-- =====================================================================================================

-- @query P0 | Server, time zone and session settings
-- expect: MySQL 8.x; sql_mode contains STRICT_TRANS_TABLES; utf8mb4. Note global_tz / session_offset_min:
--         the app forces session time_zone '+00:00', but manual sessions (and this audit) use the server default.
-- risk: INFO  handling: if the server is not UTC, compare TIMESTAMP columns with NOW(), never with UTC_TIMESTAMP().
SELECT VERSION() AS mysql_version, @@global.time_zone AS global_tz, @@session.time_zone AS session_tz,
       @@system_time_zone AS system_tz, NOW() AS now_session, UTC_TIMESTAMP() AS now_utc,
       TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS session_offset_min, @@sql_mode AS sql_mode,
       @@character_set_database AS charset, @@collation_database AS collation_db, DATABASE() AS db,
       CURRENT_USER() AS db_user;

-- @query P1 | Grants of the audit user
-- expect: SELECT (and SHOW VIEW) only.
-- risk: BLOCKER  handling: stop and reconnect with a read-only user if the user can write.
SHOW GRANTS FOR CURRENT_USER();

-- @query L1 | Table inventory (runbook A1)
-- expect: exactly __drizzle_migrations and users.
-- risk: BLOCKER  handling: any other table may hold teacher-owned data; run L6/L7 and extend 0002 before migrating.
SELECT TABLE_NAME AS table_name, TABLE_ROWS AS approx_rows
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

-- @query L2 | Migration journal (runbook A3)
-- expect: 2 rows (0000, 0001).
-- risk: BLOCKER  handling: a different journal means production is not at the audited baseline; stop.
SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at;

-- @query L3 | User totals (runbook A4)
-- expect: record the numbers; D-section reconciliation after 0002 compares against them.
-- risk: INFO  handling: -
SELECT COUNT(*) AS total_users, SUM(role = 'admin') AS admins, SUM(appRole = 'TEACHER') AS teachers,
       SUM(appRole = 'STUDENT') AS students, SUM(appRole IS NULL) AS without_app_role,
       SUM(email IS NULL OR TRIM(email) = '') AS without_email, MAX(id) AS max_user_id
FROM users;

-- @query L4 | Teacher-signal classification (what 0002 will do with each group)
-- expect: every category is understood. T2 and T3 are the "hidden teacher" candidates.
-- risk: REVIEW  handling: T2/T3 users get no workspace from 0002. If one of them is a real teacher, either set
--       appRole='TEACHER' on the restored copy before the migration rehearsal (and in production inside the
--       maintenance window, with approval), or let them create a workspace after go-live (no content is lost:
--       before 0002 no content tables exist).
SELECT CASE
         WHEN appRole = 'TEACHER' THEN 'T1 appRole TEACHER -> ws_legacy_<id> workspace + teaching context'
         WHEN role = 'admin' THEN 'T2 admin without TEACHER -> platform ADMIN only, no workspace'
         WHEN appRole IS NULL THEN 'T3 no appRole -> no workspace, onboarding on next login'
         ELSE 'T4 appRole STUDENT -> no workspace, learning context after joining a group'
       END AS category,
       COUNT(*) AS users,
       SUM(role = 'admin') AS also_admin,
       SUM(email IS NULL OR TRIM(email) = '') AS without_email,
       SUM(loginMethod = 'demo') AS demo_logins,
       MIN(lastSignedIn) AS first_seen,
       MAX(lastSignedIn) AS last_seen
FROM users
GROUP BY category
ORDER BY category;

-- @query L5 | Hidden-teacher candidates (T2 + T3), newest activity first
-- expect: short list; each row gets a decision (teacher / student / leave) in the ticket.
-- risk: REVIEW  handling: cross-check with L8 (external exports) and support knowledge.
SELECT id, openId, name, email, role, appRole, loginMethod, createdAt, lastSignedIn
FROM users
WHERE (appRole IS NULL OR appRole <> 'TEACHER') AND (role = 'admin' OR appRole IS NULL)
ORDER BY lastSignedIn DESC;

-- @query L6 | Ownership column discovery (generates one audit query per user-reference column)
-- expect: 0 rows before 0002. If rows appear, run every generated audit_sql: it lists owners that are
--         not appRole='TEACHER' (or no longer exist) for that table.
-- risk: BLOCKER  handling: tables with user-owned content that 0002 does not know about must be mapped into
--       workspaces by an extended migration before 0002 runs.
SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS owner_column,
       CONCAT('SELECT ''', c.TABLE_NAME, '.', c.COLUMN_NAME, ''' AS source, t.`', c.COLUMN_NAME,
              '` AS user_id, u.role, u.appRole, COUNT(*) AS rows_owned FROM `', c.TABLE_NAME,
              '` t LEFT JOIN users u ON u.id = t.`', c.COLUMN_NAME,
              '` WHERE u.id IS NULL OR u.appRole IS NULL OR u.appRole <> ''TEACHER'' GROUP BY t.`',
              c.COLUMN_NAME, '`, u.role, u.appRole;') AS audit_sql
FROM information_schema.COLUMNS c
WHERE c.TABLE_SCHEMA = DATABASE()
  AND c.TABLE_NAME NOT IN ('users', '__drizzle_migrations')
  AND c.COLUMN_NAME REGEXP '^(user|owner|teacher|creator|author|student|customer|payer|assigned_?by|created_?by|uploaded_?by)(_?id)?$'
ORDER BY c.TABLE_NAME, c.COLUMN_NAME;

-- @query L7 | Content-like tables by name (groups, assignments, materials, subscriptions, AI usage)
-- expect: 0 rows before 0002.
-- risk: BLOCKER  handling: same as L6.
SELECT TABLE_NAME AS table_name, TABLE_ROWS AS approx_rows
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME REGEXP 'group|member|class|assign|task|homework|material|file|upload|exam|test|quiz|question|result|subscri|payment|billing|invoice|plan|credit|usage|ai_|llm|prompt';

-- @template L8 | External teacher evidence (billing customers, AI-usage logs, CRM) - restored copy only
-- The production database has no billing or AI-usage tables (L1/L7). Teacher evidence that lives outside the
-- database must be exported by the operator and matched by e-mail on the RESTORED COPY:
--
--   CREATE TEMPORARY TABLE _audit_external_accounts (
--     source VARCHAR(32) NOT NULL,          -- 'billing' | 'ai_usage' | 'crm' | 'support'
--     email  VARCHAR(320) NOT NULL,
--     detail VARCHAR(255) NULL              -- plan, last invoice, usage count ...
--   );
--   -- LOAD DATA LOCAL INFILE '<export.csv>' INTO TABLE _audit_external_accounts ... (or INSERT ... VALUES)
--
--   SELECT e.source, e.email, e.detail, u.id AS user_id, u.role, u.appRole,
--          CASE WHEN u.id IS NULL THEN 'no Resulio account for this e-mail'
--               ELSE 'paying / AI-using account without appRole TEACHER' END AS finding
--   FROM _audit_external_accounts e
--   LEFT JOIN users u ON LOWER(TRIM(u.email)) = LOWER(TRIM(e.email))
--   WHERE u.id IS NULL OR u.appRole IS NULL OR u.appRole <> 'TEACHER'
--   ORDER BY e.source, e.email;
--
-- risk: REVIEW  handling: accounts with billing or AI usage are treated as teachers unless support confirms
--       otherwise; decide per row before the migration (see L4 handling).

-- @query L9 | Duplicate accounts by normalised e-mail (runbook A7, extended)
-- expect: 0 rows. teacher_accounts > 1 = the same person would get two teaching workspaces.
-- risk: REVIEW  handling: no automatic merge. Record which account is canonical; merging (moving workspaces
--       and memberships) is a separate, approved task after 0002.
SELECT LOWER(TRIM(email)) AS email_norm, COUNT(*) AS accounts,
       GROUP_CONCAT(id ORDER BY id) AS user_ids,
       GROUP_CONCAT(COALESCE(appRole, '-') ORDER BY id) AS app_roles,
       GROUP_CONCAT(COALESCE(loginMethod, '-') ORDER BY id) AS login_methods,
       SUM(appRole = 'TEACHER') AS teacher_accounts
FROM users
WHERE email IS NOT NULL AND TRIM(email) <> ''
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1
ORDER BY teacher_accounts DESC, accounts DESC;

-- @query L10 | Teachers whose workspace title needs the fallback or truncation
-- expect: listed rows get title COALESCE(NULLIF(TRIM(name), ''), email, 'Tədris məkanı'), cut to 255 chars.
-- risk: INFO  handling: teacher can rename the workspace after go-live.
SELECT id, email, CHAR_LENGTH(name) AS name_length,
       CASE WHEN name IS NULL OR TRIM(name) = '' THEN IF(email IS NULL, 'fallback title', 'e-mail as title')
            ELSE 'truncated to 255' END AS title_rule
FROM users
WHERE appRole = 'TEACHER' AND (name IS NULL OR TRIM(name) = '' OR CHAR_LENGTH(name) > 255);

-- @query L11 | Demo / test accounts present in this database
-- expect: 0 rows in production.
-- risk: REVIEW  handling: demo teachers also receive a workspace; delete them after go-live or exclude them
--       in the ticket. Demo login must stay off in production (NODE_ENV=production disables it).
SELECT id, openId, email, role, appRole, loginMethod, lastSignedIn
FROM users
WHERE loginMethod = 'demo' OR openId LIKE 'demo-%' OR openId LIKE 'smoke-%'
   OR email LIKE '%@example.test' OR email LIKE '%@example.com' OR email LIKE '%.local';

-- @query L12 | Generated workspace id length (runbook A5)
-- expect: max_workspace_id_length <= 32 (column is varchar(32)).
-- risk: BLOCKER  handling: impossible below 10^22 users; stop if it ever fails.
SELECT MAX(CHAR_LENGTH(CONCAT('ws_legacy_', id))) AS max_workspace_id_length, COUNT(*) AS teachers
FROM users
WHERE appRole = 'TEACHER';


-- =====================================================================================================
-- @section post-0002
-- After 0002 (and still valid after 0003). Integrity of workspaces, memberships and attempts.
-- =====================================================================================================

-- @query M1 | Journal after 0002
-- expect: 3 rows (4 after 0003).
-- risk: BLOCKER  handling: see runbook F.
SELECT COUNT(*) AS journal_rows, MAX(created_at) AS last_created_at FROM __drizzle_migrations;

-- @query M2 | Legacy teachers without their workspace (runbook D2)
-- expect: 0 rows.
-- risk: BLOCKER  handling: re-run the 0002 INSERT ... SELECT for the missing ids (idempotent) or roll back.
SELECT l.userId
FROM _legacy_user_roles_0002 l
LEFT JOIN provider_workspaces w ON w.id = CONCAT('ws_legacy_', l.userId)
WHERE l.appRole = 'TEACHER' AND w.id IS NULL;

-- @query M3 | Content authors that own no workspace (teachers not identified by appRole)
-- expect: 0 rows.
-- risk: REVIEW  handling: the author can no longer reach that content unless they own the workspace; give them
--       a workspace (or transfer ownership) after review.
SELECT src, user_id, COUNT(*) AS rows_owned
FROM (
  SELECT 'assessments.createdBy' AS src, createdBy AS user_id FROM assessments
  UNION ALL SELECT 'questions.createdBy', createdBy FROM questions
  UNION ALL SELECT 'assessment_assignments.assignedBy', assignedBy FROM assessment_assignments
  UNION ALL SELECT 'assessment_versions.publishedBy', publishedBy FROM assessment_versions
) x
WHERE user_id NOT IN (SELECT ownerUserId FROM provider_workspaces)
GROUP BY src, user_id;

-- @query M4 | Content authored by someone other than the workspace owner
-- expect: 0 rows (workspaces are single-owner today).
-- risk: REVIEW  handling: content stays in the workspace it belongs to; confirm the owner is correct.
SELECT 'assessment' AS kind, a.id, a.createdBy AS author, w.id AS workspace_id, w.ownerUserId
FROM assessments a JOIN provider_workspaces w ON w.id = a.providerWorkspaceId
WHERE a.createdBy <> w.ownerUserId
UNION ALL
SELECT 'question', q.id, q.createdBy, w.id, w.ownerUserId
FROM questions q JOIN provider_workspaces w ON w.id = q.providerWorkspaceId
WHERE q.createdBy <> w.ownerUserId;

-- @query M5 | Attempts without a matching assignment or membership
-- expect: 0 rows, or only 'LEFT GROUP' / 'MEMBERSHIP NOT ACTIVE' / 'ASSIGNMENT REVOKED' rows.
-- risk: REVIEW (left group, revoked) / BLOCKER (orphan, corrupt)
-- handling: LEFT GROUP / NOT ACTIVE / REVOKED: keep the attempt and result; the teacher still sees them in
--           reports and the student can no longer start new attempts (by design).
--           ORPHAN / CORRUPT: investigate before 0003; do not delete without approval.
SELECT t.id AS attempt_id, t.studentId, t.assessmentId, t.status, t.assignmentId,
       aa.groupId, aa.studentId AS assigned_student, aa.status AS assignment_status, gm.status AS membership_status,
       CASE
         WHEN aa.id IS NULL THEN 'ORPHAN: assignment missing'
         WHEN aa.assessmentId <> t.assessmentId THEN 'CORRUPT: assignment belongs to another assessment'
         WHEN aa.studentId IS NOT NULL AND aa.studentId <> t.studentId THEN 'CORRUPT: individual assignment for another student'
         WHEN aa.groupId IS NOT NULL AND gm.id IS NULL THEN 'LEFT GROUP: no membership now'
         WHEN aa.groupId IS NOT NULL AND gm.status <> 'ACTIVE' THEN 'MEMBERSHIP NOT ACTIVE'
         ELSE 'ASSIGNMENT REVOKED'
       END AS finding
FROM attempts t
LEFT JOIN assessment_assignments aa ON aa.id = t.assignmentId
LEFT JOIN group_members gm ON gm.groupId = aa.groupId AND gm.userId = t.studentId
WHERE aa.id IS NULL
   OR aa.assessmentId <> t.assessmentId
   OR (aa.studentId IS NOT NULL AND aa.studentId <> t.studentId)
   OR (aa.groupId IS NOT NULL AND (gm.id IS NULL OR gm.status <> 'ACTIVE'))
   OR aa.status = 'REVOKED'
ORDER BY finding, t.id;

-- @query M6 | ws_legacy anomalies (duplicates, id/owner mismatch, missing owner)
-- expect: 0 rows. The id is derived from the owner, so a second ws_legacy for one owner can only appear
--         with a mismatching id.
-- risk: BLOCKER  handling: investigate manual inserts; never renumber workspace ids (links and events use them).
SELECT w.id, w.ownerUserId, w.title,
       CASE WHEN u.id IS NULL THEN 'owner missing'
            WHEN w.id <> CONCAT('ws_legacy_', w.ownerUserId) THEN 'id does not match owner'
            ELSE 'more than one ws_legacy for owner' END AS finding
FROM provider_workspaces w
LEFT JOIN users u ON u.id = w.ownerUserId
WHERE w.id LIKE 'ws\_legacy\_%'
  AND (u.id IS NULL
       OR w.id <> CONCAT('ws_legacy_', w.ownerUserId)
       OR (SELECT COUNT(*) FROM provider_workspaces w2
           WHERE w2.ownerUserId = w.ownerUserId AND w2.id LIKE 'ws\_legacy\_%') > 1);

-- @query M7 | Duplicate teacher data: one e-mail, several accounts that own workspaces
-- expect: 0 rows.
-- risk: REVIEW  handling: pick the canonical account with the teacher; merge is a separate approved task.
SELECT LOWER(TRIM(u.email)) AS email_norm, COUNT(DISTINCT u.id) AS accounts, COUNT(w.id) AS workspaces,
       GROUP_CONCAT(DISTINCT u.id ORDER BY u.id) AS user_ids, GROUP_CONCAT(w.id ORDER BY w.id) AS workspace_ids
FROM users u
JOIN provider_workspaces w ON w.ownerUserId = u.id
WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
GROUP BY LOWER(TRIM(u.email))
HAVING COUNT(DISTINCT u.id) > 1;

-- @query M8 | Orphans for every implicit relation (the schema has no foreign keys by design)
-- expect: 0 rows (only relations with orphans are listed).
-- risk: BLOCKER for attempts/answers/results, REVIEW otherwise
-- handling: never delete automatically. Export the orphan ids, find the cause, fix with an approved script.
SELECT relation, orphans FROM (
  SELECT 'provider_workspaces.ownerUserId -> users' AS relation, COUNT(*) AS orphans
    FROM provider_workspaces w LEFT JOIN users u ON u.id = w.ownerUserId WHERE u.id IS NULL
  UNION ALL SELECT 'study_groups.providerWorkspaceId -> provider_workspaces', COUNT(*)
    FROM study_groups g LEFT JOIN provider_workspaces w ON w.id = g.providerWorkspaceId WHERE w.id IS NULL
  UNION ALL SELECT 'group_members.groupId -> study_groups', COUNT(*)
    FROM group_members m LEFT JOIN study_groups g ON g.id = m.groupId WHERE g.id IS NULL
  UNION ALL SELECT 'group_members.userId -> users', COUNT(*)
    FROM group_members m LEFT JOIN users u ON u.id = m.userId WHERE u.id IS NULL
  UNION ALL SELECT 'questions.providerWorkspaceId -> provider_workspaces', COUNT(*)
    FROM questions q LEFT JOIN provider_workspaces w ON w.id = q.providerWorkspaceId WHERE w.id IS NULL
  UNION ALL SELECT 'assessments.providerWorkspaceId -> provider_workspaces', COUNT(*)
    FROM assessments a LEFT JOIN provider_workspaces w ON w.id = a.providerWorkspaceId WHERE w.id IS NULL
  UNION ALL SELECT 'assessments.currentVersionId -> assessment_versions', COUNT(*)
    FROM assessments a LEFT JOIN assessment_versions v ON v.id = a.currentVersionId
    WHERE a.currentVersionId IS NOT NULL AND v.id IS NULL
  UNION ALL SELECT 'assessment_questions.assessmentId -> assessments', COUNT(*)
    FROM assessment_questions aq LEFT JOIN assessments a ON a.id = aq.assessmentId WHERE a.id IS NULL
  UNION ALL SELECT 'assessment_questions.questionId -> questions', COUNT(*)
    FROM assessment_questions aq LEFT JOIN questions q ON q.id = aq.questionId WHERE q.id IS NULL
  UNION ALL SELECT 'assessment_versions.assessmentId -> assessments', COUNT(*)
    FROM assessment_versions v LEFT JOIN assessments a ON a.id = v.assessmentId WHERE a.id IS NULL
  UNION ALL SELECT 'version_questions.versionId -> assessment_versions', COUNT(*)
    FROM version_questions vq LEFT JOIN assessment_versions v ON v.id = vq.versionId WHERE v.id IS NULL
  UNION ALL SELECT 'assessment_assignments.assessmentId -> assessments', COUNT(*)
    FROM assessment_assignments aa LEFT JOIN assessments a ON a.id = aa.assessmentId WHERE a.id IS NULL
  UNION ALL SELECT 'assessment_assignments.assessmentVersionId -> assessment_versions', COUNT(*)
    FROM assessment_assignments aa LEFT JOIN assessment_versions v ON v.id = aa.assessmentVersionId
    WHERE aa.assessmentVersionId IS NOT NULL AND v.id IS NULL
  UNION ALL SELECT 'assessment_assignments.groupId -> study_groups', COUNT(*)
    FROM assessment_assignments aa LEFT JOIN study_groups g ON g.id = aa.groupId
    WHERE aa.groupId IS NOT NULL AND g.id IS NULL
  UNION ALL SELECT 'assessment_assignments.studentId -> users', COUNT(*)
    FROM assessment_assignments aa LEFT JOIN users u ON u.id = aa.studentId
    WHERE aa.studentId IS NOT NULL AND u.id IS NULL
  UNION ALL SELECT 'assessment_assignments without target (no group, no student)', COUNT(*)
    FROM assessment_assignments WHERE groupId IS NULL AND studentId IS NULL
  UNION ALL SELECT 'attempts.assessmentId -> assessments', COUNT(*)
    FROM attempts t LEFT JOIN assessments a ON a.id = t.assessmentId WHERE a.id IS NULL
  UNION ALL SELECT 'attempts.versionId -> assessment_versions', COUNT(*)
    FROM attempts t LEFT JOIN assessment_versions v ON v.id = t.versionId WHERE v.id IS NULL
  UNION ALL SELECT 'attempts.studentId -> users', COUNT(*)
    FROM attempts t LEFT JOIN users u ON u.id = t.studentId WHERE u.id IS NULL
  UNION ALL SELECT 'student_answers.attemptId -> attempts', COUNT(*)
    FROM student_answers s LEFT JOIN attempts t ON t.id = s.attemptId WHERE t.id IS NULL
  UNION ALL SELECT 'student_answers.versionQuestionId -> version_questions', COUNT(*)
    FROM student_answers s LEFT JOIN version_questions vq ON vq.id = s.versionQuestionId WHERE vq.id IS NULL
  UNION ALL SELECT 'results.attemptId -> attempts', COUNT(*)
    FROM results r LEFT JOIN attempts t ON t.id = r.attemptId WHERE t.id IS NULL
  UNION ALL SELECT 'results.studentId -> users', COUNT(*)
    FROM results r LEFT JOIN users u ON u.id = r.studentId WHERE u.id IS NULL
  UNION ALL SELECT 'result_items.resultId -> results', COUNT(*)
    FROM result_items ri LEFT JOIN results r ON r.id = ri.resultId WHERE r.id IS NULL
  UNION ALL SELECT 'auth_accounts.userId -> users', COUNT(*)
    FROM auth_accounts x LEFT JOIN users u ON u.id = x.userId WHERE u.id IS NULL
  UNION ALL SELECT 'partner_profiles.userId -> users', COUNT(*)
    FROM partner_profiles x LEFT JOIN users u ON u.id = x.userId WHERE u.id IS NULL
  UNION ALL SELECT 'platform_roles.userId -> users', COUNT(*)
    FROM platform_roles x LEFT JOIN users u ON u.id = x.userId WHERE u.id IS NULL
) o
WHERE orphans > 0;

-- @query M9 | More than one open attempt per student and assessment
-- expect: 0 rows (start is serialised with a row lock + unique attemptNo).
-- risk: BLOCKER  handling: 0003 backfill would pick an arbitrary activeAttemptId; resolve first.
SELECT assessmentId, studentId, COUNT(*) AS open_attempts, GROUP_CONCAT(id) AS attempt_ids
FROM attempts
WHERE status = 'IN_PROGRESS'
GROUP BY assessmentId, studentId
HAVING COUNT(*) > 1;

-- @query M10 | Results that disagree with their attempt
-- expect: 0 rows.
-- risk: BLOCKER  handling: investigate; the result list and scores depend on this pairing.
SELECT 'result for an open attempt' AS finding, r.id AS result_id, t.id AS attempt_id, t.status
FROM results r JOIN attempts t ON t.id = r.attemptId
WHERE t.status = 'IN_PROGRESS'
UNION ALL
SELECT 'finished attempt without result', NULL, t.id, t.status
FROM attempts t LEFT JOIN results r ON r.attemptId = t.id
WHERE t.status IN ('SUBMITTED', 'AUTO_SUBMITTED') AND r.id IS NULL
UNION ALL
SELECT 'result student differs from attempt student', r.id, t.id, t.status
FROM results r JOIN attempts t ON t.id = r.attemptId
WHERE r.studentId <> t.studentId;

-- @query M11 | TIMESTAMP 2038 limit
-- expect: 0 in every row. TIMESTAMP columns cannot store values after 2038-01-19 03:14:07 UTC.
-- risk: REVIEW  handling: "no end date" must stay NULL, never a far-future date.
SELECT 'assessments.startAt' AS col, COUNT(*) AS near_limit FROM assessments WHERE startAt >= '2037-01-01'
UNION ALL SELECT 'assessments.endAt', COUNT(*) FROM assessments WHERE endAt >= '2037-01-01'
UNION ALL SELECT 'assessment_assignments.availableUntil', COUNT(*) FROM assessment_assignments WHERE availableUntil >= '2037-01-01'
UNION ALL SELECT 'attempts.deadlineAt', COUNT(*) FROM attempts WHERE deadlineAt >= '2037-01-01';


-- =====================================================================================================
-- @section pre-0003
-- Baseline immediately before 0003. Keep the output: post-0003 reconciliation compares against it.
-- =====================================================================================================

-- @query Q1 | Row counts that 0003 must not change
-- expect: record; identical after 0003 (R2).
-- risk: INFO  handling: -
SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM provider_workspaces) AS workspaces,
       (SELECT COUNT(*) FROM study_groups) AS study_groups, (SELECT COUNT(*) FROM group_members) AS group_members,
       (SELECT COUNT(*) FROM assessments) AS assessments, (SELECT COUNT(*) FROM assessment_assignments) AS assignments,
       (SELECT COUNT(*) FROM attempts) AS attempts, (SELECT COUNT(*) FROM student_answers) AS student_answers,
       (SELECT COUNT(*) FROM results) AS results, (SELECT COUNT(*) FROM result_items) AS result_items;

-- @query Q2 | Attempts by status
-- expect: only IN_PROGRESS, SUBMITTED, AUTO_SUBMITTED before 0003.
-- risk: BLOCKER  handling: any other value would be rejected by the new enum; stop.
SELECT status, COUNT(*) AS attempts FROM attempts GROUP BY status ORDER BY status;

-- @query Q3 | Open attempts whose deadline already passed (the new sweeper finalises them after deploy)
-- expect: record. Within 30 s of the new code starting, every row is auto-submitted (with answers) or marked
--         EXPIRED_NO_ANSWERS (without answers); results appear for the auto-submitted ones.
-- risk: REVIEW  handling: tell affected teachers; the old code finalised these lazily, so they may be months old.
SELECT COUNT(*) AS stale_open_attempts, MIN(t.deadlineAt) AS oldest_deadline,
       SUM(EXISTS (SELECT 1 FROM student_answers s WHERE s.attemptId = t.id AND s.answer IS NOT NULL
                   AND JSON_TYPE(s.answer) <> 'NULL'
                   AND s.answer NOT IN (CAST('""' AS JSON), CAST('[]' AS JSON), CAST('{}' AS JSON)))) AS will_auto_submit
FROM attempts t
WHERE t.status = 'IN_PROGRESS' AND t.deadlineAt < NOW();

-- @query Q4 | Answer shapes that the answeredCount backfill ignores
-- expect: record.
-- risk: INFO  handling: -
SELECT SUM(answer IS NULL) AS sql_null, SUM(JSON_TYPE(answer) = 'NULL') AS json_null,
       SUM(answer = CAST('""' AS JSON)) AS empty_string, SUM(answer = CAST('[]' AS JSON)) AS empty_array,
       SUM(answer = CAST('{}' AS JSON)) AS empty_object, COUNT(*) AS total_answers
FROM student_answers;

-- @query Q5 | Attempts with an unusable questionOrder
-- expect: 0 rows (totalQuestionCount is backfilled from JSON_LENGTH(questionOrder)).
-- risk: BLOCKER  handling: fix questionOrder from the version before 0003.
SELECT id, status, JSON_TYPE(questionOrder) AS json_type
FROM attempts
WHERE questionOrder IS NULL OR JSON_TYPE(questionOrder) <> 'ARRAY' OR JSON_LENGTH(questionOrder) = 0;


-- =====================================================================================================
-- @section post-0003
-- Reconciliation right after 0003 (before users start new attempts). M-section queries stay valid too.
-- =====================================================================================================

-- @query R1 | Journal after 0003
-- expect: 4 rows; last created_at = 1790701222563.
-- risk: BLOCKER  handling: see runbook F.
SELECT COUNT(*) AS journal_rows, MAX(created_at) AS last_created_at FROM __drizzle_migrations;

-- @query R2 | Row counts (compare with Q1)
-- expect: identical to Q1.
-- risk: BLOCKER  handling: any difference = restore from backup (runbook F3).
SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM provider_workspaces) AS workspaces,
       (SELECT COUNT(*) FROM study_groups) AS study_groups, (SELECT COUNT(*) FROM group_members) AS group_members,
       (SELECT COUNT(*) FROM assessments) AS assessments, (SELECT COUNT(*) FROM assessment_assignments) AS assignments,
       (SELECT COUNT(*) FROM attempts) AS attempts, (SELECT COUNT(*) FROM student_answers) AS student_answers,
       (SELECT COUNT(*) FROM results) AS results, (SELECT COUNT(*) FROM result_items) AS result_items;

-- @query R3 | Attempt backfill consistency
-- expect: every column 0.
-- risk: BLOCKER  handling: roll back 0003 (runbook F2) and investigate.
--   answered_mismatch uses the migration rule; after go-live the app also ignores whitespace-only text, so run
--   this immediately after the migration.
SELECT SUM(t.totalQuestionCount <> JSON_LENGTH(t.questionOrder)) AS total_question_mismatch,
       SUM(t.answeredCount <> (SELECT COUNT(*) FROM student_answers s
                               WHERE s.attemptId = t.id AND s.answer IS NOT NULL AND JSON_TYPE(s.answer) <> 'NULL'
                                 AND s.answer NOT IN (CAST('""' AS JSON), CAST('[]' AS JSON), CAST('{}' AS JSON)))) AS answered_mismatch,
       SUM(t.lastActivityAt IS NULL) AS missing_last_activity,
       SUM(t.status = 'AUTO_SUBMITTED' AND t.autoSubmittedAt IS NULL) AS auto_submitted_without_time,
       SUM(t.status <> 'AUTO_SUBMITTED' AND t.autoSubmittedAt IS NOT NULL) AS unexpected_auto_submit_time,
       COUNT(*) AS attempts
FROM attempts t;

-- @query R4 | Progress rows versus attempts
-- expect: progress_rows = student_assessment_pairs and every other column 0. After go-live progress_rows may
--         exceed pairs (students who only viewed an assessment).
-- risk: BLOCKER  handling: roll back 0003 (runbook F2) and investigate.
SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT assessmentId, studentId FROM attempts) d) AS student_assessment_pairs,
       (SELECT COUNT(*) FROM assessment_student_progress) AS progress_rows,
       (SELECT COUNT(*) FROM assessment_student_progress p
         WHERE p.attemptCount <> (SELECT COUNT(*) FROM attempts t
                                  WHERE t.assessmentId = p.assessmentId AND t.studentId = p.studentId)) AS attempt_count_mismatch,
       (SELECT COUNT(*) FROM assessment_student_progress p LEFT JOIN attempts t ON t.id = p.activeAttemptId
         WHERE p.activeAttemptId IS NOT NULL AND (t.id IS NULL OR t.status <> 'IN_PROGRESS')) AS bad_active_attempt,
       (SELECT COUNT(*) FROM attempts t
         WHERE t.status = 'IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM assessment_student_progress p
                                                        WHERE p.activeAttemptId = t.id)) AS open_attempt_not_tracked,
       (SELECT COUNT(*) FROM attempts t
         WHERE NOT EXISTS (SELECT 1 FROM assessment_student_progress p
                           WHERE p.assessmentId = t.assessmentId AND p.studentId = t.studentId)) AS attempts_without_progress;

-- @query R5 | New column defaults on existing rows
-- expect: both 0.
-- risk: BLOCKER  handling: roll back 0003 and investigate.
SELECT (SELECT COUNT(*) FROM student_answers WHERE revision <> 0) AS nonzero_revisions,
       (SELECT COUNT(*) FROM assessments WHERE inactivityThresholdMinutes <> 10) AS non_default_threshold;

-- @query R6 | Attempt status enum
-- expect: enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','EXPIRED_NO_ANSWERS','VOIDED').
-- risk: BLOCKER  handling: roll back 0003.
SELECT COLUMN_TYPE AS attempts_status_type
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attempts' AND COLUMN_NAME = 'status';

-- @query R7 | Indexes created by 0003
-- expect: 5 rows.
-- risk: BLOCKER  handling: roll back 0003; without them the dashboards scan whole tables.
SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, MIN(NON_UNIQUE) AS non_unique,
       GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_in_index
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND INDEX_NAME IN ('assessment_progress_student_unique', 'assessment_progress_activity_idx', 'activity_entity_idx',
                     'activity_user_idx', 'attempts_assessment_status_idx')
GROUP BY TABLE_NAME, INDEX_NAME
ORDER BY TABLE_NAME, INDEX_NAME;

-- @query R8 | Orphans in the 0003 tables
-- expect: 0 rows.
-- risk: REVIEW  handling: export ids; never delete automatically.
SELECT relation, orphans FROM (
  SELECT 'assessment_student_progress.assessmentId -> assessments' AS relation, COUNT(*) AS orphans
    FROM assessment_student_progress p LEFT JOIN assessments a ON a.id = p.assessmentId WHERE a.id IS NULL
  UNION ALL SELECT 'assessment_student_progress.studentId -> users', COUNT(*)
    FROM assessment_student_progress p LEFT JOIN users u ON u.id = p.studentId WHERE u.id IS NULL
  UNION ALL SELECT 'student_activity_events.userId -> users', COUNT(*)
    FROM student_activity_events e LEFT JOIN users u ON u.id = e.userId WHERE u.id IS NULL
  UNION ALL SELECT 'student_activity_events.providerWorkspaceId -> provider_workspaces', COUNT(*)
    FROM student_activity_events e LEFT JOIN provider_workspaces w ON w.id = e.providerWorkspaceId
    WHERE e.providerWorkspaceId IS NOT NULL AND w.id IS NULL
) o
WHERE orphans > 0;

-- @query R9 | Time zone of rows written by the new app (run right after the smoke-test login post-deploy)
-- expect: both *_minutes_ago between 0 and a few minutes. users.lastSignedIn is written by the app as an
--         explicit Date, student_activity_events.createdAt by DEFAULT now(); a difference of about the server's
--         UTC offset (e.g. 240) means the app's session time_zone '+00:00' (server/db.ts) is not in effect.
-- risk: BLOCKER  handling: stop traffic, check server/db.ts, roll back if unclear.
SELECT NOW() AS db_now,
       (SELECT MAX(lastSignedIn) FROM users) AS newest_sign_in,
       TIMESTAMPDIFF(MINUTE, (SELECT MAX(lastSignedIn) FROM users), NOW()) AS sign_in_minutes_ago,
       (SELECT MAX(createdAt) FROM student_activity_events) AS newest_event,
       TIMESTAMPDIFF(MINUTE, (SELECT MAX(createdAt) FROM student_activity_events), NOW()) AS event_minutes_ago;

-- =====================================================================================================
-- @section post-0004
-- Reconciliation right after 0004 (admin console). When 0002-0004 run in one window, R1 shows 5 rows; S1 is the
-- journal check then.
-- =====================================================================================================

-- @query S1 | Journal after 0004
-- expect: 5 rows; last created_at = 1790707991583.
-- risk: BLOCKER  handling: see runbook F4/F5.
SELECT COUNT(*) AS journal_rows, MAX(created_at) AS last_created_at FROM __drizzle_migrations;

-- @query S2 | Platform roles after the rename
-- expect: only SUPER_ADMIN / SUPPORT_ADMIN rows; SUPER_ADMIN count = legacy admin count (D4).
-- risk: BLOCKER  handling: an ADMIN/SUPPORT value means the enum rename did not finish; restore (F1).
SELECT role, COUNT(*) AS users FROM platform_roles GROUP BY role ORDER BY role;

-- @query S3 | Role enum and new user columns
-- expect: role_type = enum('SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER');
--         sessions_valid_after_precision = 3.
-- risk: BLOCKER  handling: roll back 0004 (runbook F5).
SELECT (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_roles' AND COLUMN_NAME = 'role') AS role_type,
       (SELECT DATETIME_PRECISION FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'sessionsValidAfter') AS sessions_valid_after_precision;

-- @query S4 | Defaults on existing users
-- expect: every column 0 right after the migration (nobody suspended, no session revoked).
-- risk: BLOCKER  handling: roll back 0004 (runbook F5).
SELECT SUM(accountStatus <> 'ACTIVE') AS not_active, SUM(sessionsValidAfter IS NOT NULL) AS revoked,
       SUM(suspendedAt IS NOT NULL) AS suspended_at_set
FROM users;

-- @query S5 | Legacy admins and the SUPER_ADMIN allowlist
-- expect: one row per SUPER_ADMIN; compare the e-mails with the approved SUPER_ADMIN_EMAILS list. A SUPER_ADMIN
--         whose e-mail is not on the list keeps the row but gets no admin access.
-- risk: REVIEW  handling: add approved e-mails to SUPER_ADMIN_EMAILS; revoke the rest with pnpm admin:grant --revoke.
SELECT u.id, u.email, r.role, r.createdAt
FROM platform_roles r JOIN users u ON u.id = r.userId
WHERE r.role IN ('SUPER_ADMIN', 'SUPPORT_ADMIN')
ORDER BY r.role, u.id;

-- @query S6 | Append-only audit triggers (after the ops step)
-- expect: 2 rows (audit_logs_no_update, audit_logs_no_delete) once audit-append-only-triggers.sql has run.
-- risk: REVIEW  handling: run docs/migrations/audit-append-only-triggers.sql with the privileged account.
SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'audit_logs'
ORDER BY TRIGGER_NAME;
