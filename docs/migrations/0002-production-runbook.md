# Migrations 0002 + 0003 + 0004 — production runbook

Status: **not approved for production.** Do not run `pnpm db:migrate` against a live database until every
"Go / No-Go" item below is checked and signed off. Never run `pnpm db:push` against production (it generates
new migrations from the schema before migrating).

Production is expected to be at migration 0001 (confirm with audit L2). The current app needs 0002, 0003 and
0004 (admin console), and `pnpm db:migrate` applies all three in one run; there is no app version that runs on
0002 or 0003 alone.

Related files:

| File | Purpose |
| --- | --- |
| `drizzle/0002_assessment_engine.sql` | Workspaces, groups, assessments, attempts, results; legacy role conversion |
| `drizzle/0003_activity_tracking.sql` | Attempt activity columns + backfill, `assessment_student_progress`, `student_activity_events` |
| `drizzle/0004_admin_console.sql` | Account status/revocation columns, admin role rename, partner review fields, `audit_logs`, `security_events`, feature flag tables |
| `docs/migrations/legacy-audit-queries.sql` | Read-only audit + reconciliation pack (sections pre-0002, post-0002, pre-0003, post-0003, post-0004) |
| `docs/migrations/0004-rollback.sql` | Reverse of 0004 (keeps data in `_rollback_0004_*` tables) |
| `docs/migrations/audit-append-only-triggers.sql` | Privileged ops step after 0004: `audit_logs` rejects UPDATE/DELETE |
| `scripts/admin-grant.ts` (`pnpm admin:grant`) | Grants/revokes platform admin roles with a SYSTEM audit row (only way to manage SUPER_ADMIN) |
| `docs/migrations/0003-rollback.sql` | Reverse of 0003 (keeps data in `_rollback_0003_*` tables) |
| `docs/migrations/0002-rollback.sql` | Reverse of 0002 (restores legacy roles from `_legacy_user_roles_0002`) |
| `scripts/migration-rehearsal.mjs` (`pnpm db:rehearse`) | Full rehearsal on a disposable MySQL: migrate, audit, backup/restore, both rollbacks |
| `scripts/inspect-schema.mjs` (`pnpm db:inspect`) | Compares a live schema with a drizzle snapshot |
| `scripts/browser-smoke.mjs` | Local browser smoke (never against production; it refuses non-local URLs) |

### What 0002 does

- adds `users.avatarUrl`, `users.lastActiveContext`;
- creates `auth_accounts`, `provider_workspaces`, `partner_profiles`, `platform_roles`, `study_groups`,
  `group_members`, `questions`, `assessments`, `assessment_questions`, `assessment_assignments`,
  `assessment_versions`, `version_questions`, `attempts`, `student_answers`, `results`, `result_items`;
- copies every user's legacy `role`/`appRole` into `_legacy_user_roles_0002` (kept for rollback, not used by the app);
- inserts `platform_roles` ADMIN for `role = 'admin'`;
- inserts one `provider_workspaces` row `ws_legacy_<userId>` per `appRole = 'TEACHER'` and sets their
  `lastActiveContext = 'teaching'`;
- drops `users.role` and `users.appRole`.

### What 0003 does

- creates `assessment_student_progress` and `student_activity_events`;
- extends the attempt status enum with `EXPIRED_NO_ANSWERS` and `VOIDED`;
- adds attempt activity columns (`lastActivityAt`, `lastAutosaveAt`, `lastHeartbeatAt`, `answeredCount`,
  `totalQuestionCount`, `autoSubmittedAt`, `voidedBy`, `voidedAt`), `student_answers.revision`,
  `assessments.inactivityThresholdMinutes` (default 10) and four indexes;
- backfills the new columns and one progress row per (assessment, student) from existing attempts. On a
  database coming from 0001 these tables are empty, so the backfill is a no-op.

### What 0004 does

- adds `users.accountStatus` (default `ACTIVE`), `suspendedAt`, `sessionsValidAfter` (`timestamp(3)`, NULL = no
  revocation) and `lastSeenAt`, with two indexes;
- renames admin roles in three statements: expand the enum, `ADMIN` → `SUPER_ADMIN` and `SUPPORT` →
  `SUPPORT_ADMIN`, shrink the enum to the five new roles; adds `platform_roles.createdBy`;
- appends `INFO_REQUESTED` to the partner status enum and adds `applicationAnswers`, `decidedBy`, `decidedAt`;
- creates `audit_logs`, `security_events`, `feature_flags`, `feature_flag_overrides` (empty).

A renamed SUPER_ADMIN only has console access if its e-mail is on `SUPER_ADMIN_EMAILS` (audit S5 lists them).
The append-only triggers are not part of 0004: creating triggers needs a privileged account under binary
logging (ERROR 1419 for the app user), so they are a separate step (C8).

MySQL DDL is not transactional. A failure part-way leaves the schema half-migrated (see F4).

## What production can contain before 0002

Before this refactor every exam, group, task, material, payment, AI draft and notification lived in the
in-memory store (`server/resulioStore.ts`) and was lost on every restart. The migration history only ever
created `users` (0000) and added `preferredLocale`/`appRole` (0001). There has never been a subscriptions table.

So the expected pre-0002 schema is exactly: `users`, `__drizzle_migrations`. This is an assumption until audit
L1 confirms it on the real database. If L1, L6 or L7 show any other table, stop and extend 0002 before migrating.

`appRole = 'TEACHER'` is **not** assumed to identify every historical teacher. Audits L4, L5 and the L8
template (billing customers, AI-usage logs, CRM exports matched by e-mail) produce the list of "hidden teacher"
candidates; each gets a decision in the migration ticket before the window.

## Steps (maps to the 13-step production plan)

| # | Step | Section |
| --- | --- | --- |
| 1 | Maintenance window seçilir | Go / No-Go |
| 2 | Production DB full backup alınır | B1–B3 |
| 3 | Backup restore test edilir | B4 |
| 4 | Read-only preflight audit işlədilir | A (restored copy first) |
| 5 | Data count report alınır | A (L3, L4) → ticket |
| 6 | Migration preview yoxlanır | A0 (rehearsal on the restored copy) |
| 7 | Migration işlədilir | C |
| 8 | Post-migration reconciliation query işlədilir | D |
| 9 | Google login test edilir | E |
| 10 | Teacher/student context test edilir | E |
| 11 | Existing assessment/result test edilir | E |
| 12 | Monitoring açılır | E (monitoring) |
| 13 | Rollback qərarı üçün vaxt pəncərəsi saxlanılır | F (decision window) |

## Go / No-Go

- [ ] Maintenance window agreed (low-traffic hour, 60 min + 60 min rollback reserve); the old app can be stopped.
- [ ] Backup taken, checksum stored, and a test restore into a scratch database succeeded (section B).
- [ ] Audit pre-0002 section run on the restored copy; results attached to the ticket (section A).
- [ ] L1 shows only `users` and `__drizzle_migrations`; L6 and L7 return 0 rows.
- [ ] L2 shows exactly the 0000 and 0001 migrations applied.
- [ ] L3/L4 counts recorded; every L5 hidden-teacher candidate and every L8 external match has a decision.
- [ ] Duplicate-email report (L9) reviewed; each duplicate has an owner decision (no automatic merge).
- [ ] Users without email reviewed (they cannot be auto-linked on Google login).
- [ ] L11 demo/test accounts reviewed; production runs with `NODE_ENV=production` (demo login is then off;
      `DISABLE_DEMO_LOGIN=1` turns it off in any other environment reachable from outside).
- [ ] P0 recorded; the app's session `time_zone = '+00:00'` (server/db.ts) is in the release being deployed.
- [ ] Migration dry run (A0) on the restored copy passed D and the post-0002/post-0003/post-0004 audit sections.
- [ ] Rollback owner on call; `0004-rollback.sql`, `0003-rollback.sql` and `0002-rollback.sql` reviewed against
      this database.
- [ ] `SUPER_ADMIN_EMAILS` approved in writing (who owns the platform); every L4/L5 legacy admin not on it has a
      decision (keep without access, or revoke after go-live).
- [ ] `AUDIT_HASH_SECRET` (random, ≥ 32 characters, different from `SESSION_SECRET`) and `APP_ENV=production` set
      in the deployment environment.
- [ ] Privileged database account available for the trigger step (C8); the app account stays unprivileged.
- [ ] Previous app build/image is available for redeploy.

## A. Read-only preflight audit

Run `docs/migrations/legacy-audit-queries.sql`, section **pre-0002**, with a read-only user — first on the
restored copy from B4, then (only with explicit approval) on production to confirm the counts match. The pack
states the expected result, risk category and handling for every query.

| Pack id | Former id | Checks |
| --- | --- | --- |
| P0 | B1 | Server version, time zone, sql_mode, charset |
| P1 | – | The audit user can only read |
| L1 | A1 | Table inventory: only `users`, `__drizzle_migrations` |
| L2 | A3 | Journal: 0000, 0001 |
| L3 | A4 | User totals |
| L4, L5 | A4 | Teacher-signal classification and hidden-teacher candidates |
| L6, L7 | A6 | Ownership columns / content-like tables anywhere in the schema |
| L8 | – | Template: external billing / AI-usage / CRM evidence (restored copy only) |
| L9 | A7 | Duplicate e-mails (normalised) incl. duplicate teacher accounts |
| L10 | A5 | Workspace title fallback / truncation |
| L11 | A9 | Demo / test accounts |
| L12 | A5 | Workspace id length |

Users without e-mail (former A8): `SELECT id, openId, name, loginMethod, appRole, lastSignedIn FROM users WHERE email IS NULL;`

### A0. Migration preview on the restored copy

1. On the scratch database restored in B4 (never production): `DATABASE_URL=<scratch> pnpm db:migrate`.
2. Run section D, then audit sections **post-0002** and **post-0003** of the pack. All BLOCKER queries must pass.
3. `node scripts/inspect-schema.mjs <scratch-url> --expect-legacy` must report that the live schema matches
   `0003_snapshot` (`--expect-legacy` tolerates `_legacy_user_roles_0002`).
4. Apply `0003-rollback.sql`, then `0002-rollback.sql` on the scratch copy and confirm L1–L3 match the
   pre-migration report (proves the reverse path on real data).
5. `pnpm db:rehearse` is the same procedure on synthetic legacy data (77 checks) and must pass on the release
   commit.

### Risk summary from the design

| Risk | Expected result | Why |
| --- | --- | --- |
| Duplicate workspaces | 0 | Workspace id is derived from the user id and is the primary key; a re-run fails instead of duplicating (M6). |
| Orphaned exams/materials/tasks/subscriptions | 0 | No such tables exist before 0002 (L1, L6, L7). |
| Teacher without workspace | 0 for `appRole = 'TEACHER'` | Every such row gets one (D2/M2). Hidden teachers (L4/L5/L8) get none and create one after login. |
| Duplicate user on first Google login | Only for L9 / no-email accounts | Google login links to a single legacy user with the same verified email and no provider link. |
| Mass auto-submit at deploy | 0 from 0001 | The sweeper finalises open attempts past their deadline within 30 s (Q3). From 0001 there are no attempts. |
| Time zone shift | 0 | App sessions use UTC; R9 detects a shift after the first login. |

## B. Backup

1. Record P0 (`VERSION()`, time zones, sql_mode) and `SELECT @@gtid_mode;` in the ticket.
2. Logical backup, consistent snapshot, immediately before the migration (app already stopped):

   ```bash
   mysqldump --single-transaction --routines --triggers --hex-blob \
     --set-gtid-purged=OFF --default-character-set=utf8mb4 \
     -h "$HOST" -P "$PORT" -u "$USER" -p "$DB" > resulio-pre-0002-$(date +%Y%m%d%H%M).sql
   sha256sum resulio-pre-0002-*.sql > resulio-pre-0002.sha256
   ```

3. If the host (e.g. Railway) offers volume snapshots/backups, take one as well.
4. Restore the dump into a scratch database (`mysql --default-character-set=utf8mb4 <scratch> < dump.sql`), verify
   the checksum, and rerun L1–L3 there; the counts must match production.
5. Store the dump outside the database host (two locations); keep it until the cleanup step (section G).

## C. Execution (maintenance window)

The new code and the old code are not schema-compatible: old code reads `users.appRole`, new code reads
`provider_workspaces` and the 0003 columns. Both must never run against the same schema.

1. Stop the old app (or put it in maintenance mode) so no writes happen.
2. Take the backup (section B) and verify its checksum.
3. Rerun L2 and L3 on production: journal still 0000/0001, user count equal to the report.
4. Run `pnpm db:migrate` with the production `DATABASE_URL` (applies 0002, 0003, then 0004).
5. Run reconciliation (section D). Any failed BLOCKER check = rollback (section F) before the new app starts.
6. Deploy the new app version (with `SESSION_SECRET`, Google OAuth settings unchanged, `NODE_ENV=production`,
   `APP_ENV=production`, `AUDIT_HASH_SECRET`, `SUPER_ADMIN_EMAILS`).
7. Run the smoke test (section E), then R9.
8. Trigger ops step, with the privileged account (never the app's): run
   `docs/migrations/audit-append-only-triggers.sql` through the `mysql` client, then audit S6 must list both
   triggers. Without this step the app still has no update/delete path for `audit_logs`; the triggers also stop
   manual SQL.
9. Admin bootstrap (only if no approved SUPER_ADMIN came over from legacy admins): the owner signs in with
   Google once, then `pnpm admin:grant --email <owner> --role SUPER_ADMIN --reason "<ticket>"` (dry run),
   then the same command with `--yes`. It writes a SYSTEM audit row. SUPPORT_ADMIN is granted from the console.

## D. Post-migration reconciliation

0002-specific checks (users and roles):

```sql
-- D1. User count unchanged (compare with L3.total_users).
SELECT COUNT(*) FROM users;

-- D2. Every legacy teacher has exactly its workspace. Must return 0 rows.
SELECT l.userId FROM _legacy_user_roles_0002 l
LEFT JOIN provider_workspaces w ON w.id = CONCAT('ws_legacy_', l.userId) AND w.ownerUserId = l.userId
WHERE l.appRole = 'TEACHER' AND w.id IS NULL;

-- D3. No workspace for a non-teacher legacy user and no workspace without an owner. Both must return 0.
SELECT w.id FROM provider_workspaces w
JOIN _legacy_user_roles_0002 l ON l.userId = w.ownerUserId
WHERE w.id LIKE 'ws\_legacy\_%' AND (l.appRole IS NULL OR l.appRole <> 'TEACHER');
SELECT w.id FROM provider_workspaces w LEFT JOIN users u ON u.id = w.ownerUserId WHERE u.id IS NULL;

-- D4. Admins carried over. Both numbers must be equal. After 0004 the role is SUPER_ADMIN (use 'ADMIN' only
--     when checking a database that stopped at 0003).
SELECT (SELECT COUNT(*) FROM _legacy_user_roles_0002 WHERE role = 'admin') AS legacy_admins,
       (SELECT COUNT(*) FROM platform_roles WHERE role = 'SUPER_ADMIN') AS platform_admins;

-- D5. lastActiveContext set only for legacy teachers.
SELECT (SELECT COUNT(*) FROM _legacy_user_roles_0002 WHERE appRole = 'TEACHER') AS teachers,
       (SELECT COUNT(*) FROM users WHERE lastActiveContext = 'teaching') AS teaching_context;

-- D6. Legacy columns gone, new columns present.
SELECT column_name FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'users'
  AND column_name IN ('role', 'appRole', 'avatarUrl', 'lastActiveContext');

-- D8. Only admin roles in platform_roles (after 0004: SUPER_ADMIN / SUPPORT_ADMIN; sanity check).
SELECT role, COUNT(*) FROM platform_roles GROUP BY role;
```

Then run pack sections **post-0002** (M1–M11), **post-0003** (R1–R8) and **post-0004** (S1–S5). Coming from
0001, the new tables are empty, so R2 must show `users` = L3.total_users, `workspaces` = L4 T1 count and 0
everywhere else. With 0004 in the same run, R1 shows 5 journal rows and S1 is the journal check. R9 runs after
the first smoke-test login (section E); S6 after the trigger step (C8).

Schema check: `node scripts/inspect-schema.mjs "$DATABASE_URL" --expect-legacy` → matches `0004_snapshot`.

After go-live, run M5, M8 and R8 weekly for orphan detection (read-only; never delete automatically).

## E. Production smoke test

- [ ] Google login of a legacy teacher lands in `/teacher`, sees "Tədris məkanım", no second `users` row
      (`SELECT COUNT(*) FROM users WHERE LOWER(email) = '<email>'` = 1).
- [ ] R9 immediately after that login: `sign_in_minutes_ago` between 0 and a few minutes.
- [ ] Google login of a legacy student with no group lands on `/welcome`.
- [ ] Cancelling the Google consent screen returns to `/?login=cancelled` without an error page.
- [ ] Allowlisted SUPER_ADMIN (signed in with Google) gets `admin.me`; a normal user and a non-allowlisted
      legacy admin get `FORBIDDEN:NOT_ADMIN`; a denial appears in `security_events`.
- [ ] SUPER_ADMIN revokes the sessions of a test account with a reason: that account's old cookie stops working,
      a new Google sign-in works, and exactly one `USER_SESSIONS_REVOKED` row is in `audit_logs`.
- [ ] Teacher creates a group, an exam, publishes it; a second account joins by invite and is approved.
- [ ] Student starts (double-click creates one attempt), autosaves ("Yadda saxlanıldı"), reloads (answers and
      timer resume) and submits; the result follows the visibility rules.
- [ ] Teacher dashboard shows the attempt in "Bu günün vəziyyəti" and in the participants report.
- [ ] Teacher cannot open another workspace (edited `x-resulio-workspace` header returns `NO_WORKSPACE`).
- [ ] Avatar menu switches Learning ↔ Teaching without re-login; settings shows both contexts.
- [ ] Phone-width check of the exam screen and the teacher dashboard (no horizontal scrolling).

Monitoring (first 24 hours):

- [ ] Server logs: no `INTERNAL_ERROR` spikes; watch `ER_` MySQL errors, `ATTEMPT_CLOSED` and `NO_WORKSPACE` rates.
- [ ] Every 30 minutes for the first 2 hours: `SELECT status, COUNT(*) FROM attempts GROUP BY status;` and M9, M10.
- [ ] Sweeper: `SELECT COUNT(*) FROM attempts WHERE status = 'IN_PROGRESS' AND deadlineAt < NOW() - INTERVAL 2 MINUTE;` = 0.
- [ ] Database CPU / connections at pre-deploy levels.

## F. Rollback

### Decision window

Keep the maintenance crew and the backup for **24 hours** after go-live. Before new writes: F1. After the new
app has accepted writes: F1 only if losing those writes is acceptable, otherwise F2/F3. Record the decision
and its time in the ticket.

Triggers: any BLOCKER reconciliation failure, a legacy teacher unable to reach their workspace, a second
`users` row on Google login, lost answers/results, a time-zone shift (R9), or sustained `INTERNAL_ERROR`s.

### F1. Preferred: restore the backup

Use when the migration or reconciliation failed before the new app accepted writes.

1. Stop the app.
2. Restore the dump from section B into the production database (drop and recreate the schema first).
3. Verify L1–L3 match the pre-migration report.
4. Redeploy the previous app version.

### F2. Reverse 0003 only (keep 0002; the 0003 app has served traffic)

Only useful with an app build that runs on 0002 (the current release does not; build it from the pre-0003
commit first).

1. Stop the app. Export `student_activity_events` and `assessment_student_progress` (`mysqldump --no-create-info`).
2. Run `docs/migrations/0003-rollback.sql`. It copies the activity columns into `_rollback_0003_attempts`,
   `_rollback_0003_answer_revisions`, `_rollback_0003_inactivity_thresholds`, renames the two new tables to
   `_rollback_0003_*`, maps `EXPIRED_NO_ANSWERS`/`VOIDED` to `AUTO_SUBMITTED` (original status kept) and deletes
   the journal row with `created_at = 1790701222563`.
3. `node scripts/inspect-schema.mjs "$DATABASE_URL" --expect-legacy --snapshot drizzle/meta/0002_snapshot.json`.
4. Redeploy the 0002-compatible build.

### F3. Reverse 0002 + 0003 (keep users, lose new content)

Use only if the new app has already accepted writes worth keeping partially. Legacy roles are restored
losslessly from `_legacy_user_roles_0002`. Everything created in the new tables (groups, exams, attempts,
results, workspaces created after go-live) is **not** representable in the old schema.

1. Stop the app. Export the new tables: `mysqldump --no-create-info <db> <tables>` and store it with the backup.
2. Run `docs/migrations/0003-rollback.sql`, then `docs/migrations/0002-rollback.sql`. The 0002 script deletes
   exactly the journal row with `created_at = 1788785600000` (no `ORDER BY … LIMIT 1` guesswork).
3. Drop the `_rollback_0003_*` tables after the export is verified.
4. Verify L1–L3, then redeploy the previous app version.

Both scripts are exercised by `pnpm db:rehearse` (schema returns to the 0002 snapshot, then to the pre-0002
table set with every legacy role restored exactly).

### F4. Partial failure during `db:migrate`

1. Stop. Do not rerun blindly (CREATE TABLE statements are not idempotent).
2. `SHOW TABLES;`, `SELECT * FROM __drizzle_migrations;` and the users column list (pack query L1 plus
   `SHOW COLUMNS FROM users`) to see how far it got. The statements run in file order.
3. Failure inside 0002 before `ALTER TABLE users DROP COLUMN role`: legacy data is intact; restore the backup
   (F1) or drop the tables created so far and fix the cause.
4. Failure inside 0002 after the drops: `_legacy_user_roles_0002` holds the roles; restore the backup (F1).
5. Failure inside 0003 (journal has 3 rows): 0002 is complete. Restore the backup (F1) — preferred — or reverse
   the statements that ran (see `0003-rollback.sql`) and rerun `pnpm db:migrate`.
6. Failure inside 0004 (journal has 4 rows): 0002/0003 are complete. Rerunning `db:migrate` stops at the first
   `CREATE TABLE`. A stop between the role `UPDATE`s and the enum shrink leaves `SUPER_ADMIN` rows
   under a wide enum; the 0003 app then sees no admins. Restore the backup (F1). This path is rehearsed.

### F5. Reverse 0004 only (keep 0002 + 0003; the 0004 app has served traffic)

Needs an app build from before the admin console (the current release does not run on 0003).

1. **Suspended accounts regain access after this rollback** (the old app has no suspension). List them first:
   `SELECT id, email FROM users WHERE accountStatus = 'SUSPENDED';` and decide per account.
2. Stop the app. Run `docs/migrations/0004-rollback.sql`. It copies the new user/partner/role columns into
   `_rollback_0004_*`, maps `SUPER_ADMIN` → `ADMIN` and `SUPPORT_ADMIN` → `SUPPORT` (reserved-role rows are kept
   only in the copy), returns `INFO_REQUESTED` partners to `PENDING`, renames the four new tables to
   `_rollback_0004_*` (audit history and its triggers are kept) and deletes the journal row with
   `created_at = 1790707991583`.
3. `node scripts/inspect-schema.mjs "$DATABASE_URL" --expect-legacy --snapshot drizzle/meta/0003_snapshot.json`.
4. Redeploy the 0003-compatible build.

`pnpm db:rehearse` runs this script, checks the 0003 schema, and re-applies 0004.

## G. Cleanup (not before 30 days of stable operation)

- Drop `_legacy_user_roles_0002` (and any `_rollback_0003_*` / `_rollback_0004_*` tables) in a dedicated migration.
  A `_rollback_0004_audit_logs` table keeps its append-only triggers; drop them first, in an approved window.
- Delete the pre-0002 dump according to the data-retention policy.
