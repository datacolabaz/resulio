# Phase 1a verification report

Date: 2026-09-29. Scope: migrations 0000–0003, session concurrency, expiry, authorization, browser smoke,
cleanup, lint proposal, production migration preparation.

Nothing was deployed. No production database, credentials, domain, OAuth or billing setting was used or changed.
Migration 0003 (and 0002) ran only on a disposable local MySQL. Theme implementation stays paused; dark mode is
not claimed as implemented. Phase 1b dashboard UI was not started.

## Final verification run

| Command | Result |
| --- | --- |
| `pnpm check` (tsc) | 0 errors |
| `pnpm test` (unit) | 80/80 passed |
| `pnpm test:db` (real MySQL integration, `TEST_DATABASE_URL` → `resulio_it`) | 34/34 passed |
| `pnpm db:verify` (replay 4 migrations vs 0003 snapshot) | OK, 19 tables match |
| `pnpm db:rehearse` (full migration + audit rehearsal) | 77/77 checks passed |
| `pnpm contrast` | 138/138 enforced pairs pass (existing tokens; no theme changes in this phase) |
| `pnpm build` | OK (existing warning: 1.27 MB main chunk) |
| `node scripts/browser-smoke.mjs` | 35 checks: 32 PASS, 3 N/A, 0 failed |
| Lint | Not run: no ESLint is configured in the repo (see 12) |

One run of `pnpm test` first failed 4 "missing database" tests because the shell still had `DATABASE_URL` from
the smoke setup; with the variable removed all 80 pass. Test DB variables were unset after each run.

---

## 1. Real MySQL migration test report

| Item | Value |
| --- | --- |
| Server | MySQL 8.4.11 Community (portable zip in `~/.tools`, not in the repo), `127.0.0.1:3307`, local only |
| Databases | `resulio_test`, `resulio_it` (integration), `resulio_dev` (browser smoke), `resulio_rh_main_test` / `resulio_rh_restore_test` (rehearsal) |
| Users | `resulio_test` (app/test user), `root` (rehearsal creates/drops only `resulio_rh_*_test`) |
| Data | Synthetic only; no production or real user data |
| Server time zone | System (UTC+4, Asia/Baku) on purpose, to exercise the time-zone handling |
| sql_mode | `STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,…` (default strict) |
| Migrator | The real drizzle migrator (`drizzle-orm/mysql2/migrator`), same as `pnpm db:migrate` |

Rehearsal flow (`scripts/migration-rehearsal.mjs`): 0000+0001 → 12 legacy users with every edge case (admin,
admin+teacher, no appRole, empty/NULL/400-char names, no e-mail, case-variant duplicate e-mails, demo login) →
audit pre-0002 → 0002 → D1–D8 reconciliation → 0002-era exam data (group, assessment, version, 4 attempts in
three statuses, 8 answers in every JSON shape, 2 results) → audit post-0002/pre-0003 → `mysqldump` → 0003 →
backfill checks + audit post-0003 → restore into a second DB → 0003 rollback → re-apply → 0002 rollback on the
restored copy → re-apply 0002+0003 → audit against planted defects. 77/77 checks pass in about 12 s.

## 2. Migration SQL execution report

| Migration | Statements | Result on MySQL 8.4 | Journal `created_at` |
| --- | --- | --- | --- |
| `0000_initial_users.sql` | 1 | OK | – |
| `0001_user_app_role.sql` | 2 | OK | – |
| `0002_assessment_engine.sql` | 41 | OK, D1–D8 pass | 1788785600000 |
| `0003_activity_tracking.sql` | 21 | OK, backfill correct | 1790701222563 |

0003 backfill verified on real rows: `totalQuestionCount = JSON_LENGTH(questionOrder)`; `answeredCount` ignores
SQL NULL, JSON `null`, `""`, `[]`, `{}`; `lastActivityAt = submittedAt ?? startedAt`; `autoSubmittedAt` only for
`AUTO_SUBMITTED`; one progress row per (assessment, student) with the right `attemptCount`, `activeAttemptId`,
`startedAt`, `completedAt`, `latestActivityAt`; existing assessments get threshold 10; answers get revision 0;
the enum accepts `EXPIRED_NO_ANSWERS`/`VOIDED` and rejects unknown values. Both reverse scripts run cleanly and
the forward migrations re-apply afterwards. No statement failed; no warning changed data.

## 3. Schema verification report

- `pnpm db:verify`: replaying the four migrations produces exactly the 0003 snapshot (columns, types,
  nullability, defaults, primary keys, unique keys, indexes); 19 tables, `_legacy_user_roles_0002` ignored.
- `scripts/inspect-schema.mjs` against the live migrated databases: matches `0003_snapshot`; after the 0003
  rollback and on the restored pre-0003 backup it matches `0002_snapshot`.
- Audit R6/R7: attempt status enum and the five 0003 indexes/unique keys present.
- Foreign keys: 0, by design (implicit relations are checked by audit M8/R8 instead).
- Character set utf8mb4 end to end (Azerbaijani text survives: `Tədris məkanı`, 400 × `Ə` truncated to 255).
- Known limit: `TIMESTAMP` columns end at 2038-01-19; audit M11 flags far-future dates ("no end date" must be NULL).
- Time zone: `DEFAULT now()` and app-written timestamps agree because every app connection sets
  `time_zone = '+00:00'` (`server/db.ts`); covered by the integration test "database clock" and audit R9.

## 4. Legacy audit query pack

`docs/migrations/legacy-audit-queries.sql` — prepared for approval, **not run on production**. Read-only
(`SELECT`/`SHOW`); one block needing external data is a template for the restored copy only.

| Section | Queries | Purpose |
| --- | --- | --- |
| pre-0002 | P0, P1, L1–L12 (+ L8 template) | Environment, grants, inventory, journal, counts, teacher signals beyond `appRole`, ownership discovery across all tables, content-like tables, external billing/AI evidence, duplicates, title fallback, demo accounts, id length |
| post-0002 | M1–M11 | Journal, teachers without workspace, content authors without workspace, non-owner authors, attempts without membership, duplicate `ws_legacy`, duplicate teacher accounts, orphans for 27 implicit relations, multiple open attempts, result/attempt disagreement, 2038 limit |
| pre-0003 | Q1–Q5 | Baseline counts, status distribution, stale open attempts, answer shapes, questionOrder validity |
| post-0003 | R1–R9 | Journal, counts vs baseline, backfill consistency, progress vs attempts, defaults, enum, indexes, orphans in new tables, time-zone check after first login |

Every query carries its expected result, risk category (BLOCKER / REVIEW / INFO) and handling. The rehearsal
parses the file and executes every query at the matching stage; sample output is in
`docs/verification/legacy-audit-rehearsal.json`.

## 5. Legacy risk report

Production counts are **unknown** until the pre-0002 section runs on a restored copy of the production backup.
The rehearsal column shows what the queries return on the synthetic legacy data (proving they detect each case).

| Risk | Query | Rehearsal result | Expected in production | Category | Handling |
| --- | --- | --- | --- | --- | --- |
| Unknown tables with user-owned content | L1, L6, L7 | 0 | 0 (only `users` ever existed in the DB) | BLOCKER | Stop, extend 0002 to map the content into workspaces |
| Hidden teachers: admin without TEACHER | L4 T2, L5 | 1 | Unknown | REVIEW | Decide per user; teacher → set `appRole='TEACHER'` before migrating (approved) or create workspace after login |
| Hidden teachers: no appRole | L4 T3, L5 | 1 | Unknown | REVIEW | Same as above |
| Paying / AI-using accounts without TEACHER | L8 (template) | – | Unknown (no billing/AI tables in DB) | REVIEW | Operator exports billing + AI usage, match by e-mail on the restored copy |
| Duplicate accounts (normalised e-mail) | L9 | 1 pair | Unknown | REVIEW | Pick canonical account; merge is a separate approved task |
| Duplicate teacher data (one e-mail, two workspaces) | M7 | 0 clean / 1 planted | 0 right after 0002 | REVIEW | Same as above |
| Duplicate / mismatched `ws_legacy` | M6 | 0 clean / 2 planted | 0 (id = PK derived from user id) | BLOCKER | Investigate manual inserts; never renumber ids |
| Attempts without membership | M5 | 0 clean / 1 planted (student left group) | 0 (no attempts before 0002) | REVIEW/BLOCKER | Left group/revoked: keep; orphan/corrupt: investigate |
| Orphans (27 relations) | M8, R8 | 0 clean / 1 planted | 0 | BLOCKER/REVIEW | Export ids, never delete automatically |
| Content authored by non-owner | M3, M4 | 0 clean / 1 planted | 0 | REVIEW | Confirm owner |
| Teachers needing title fallback / truncation | L10 | 3 | Unknown | INFO | Teacher renames later |
| Demo/test accounts | L11 | 1 demo + example.test | 0 | REVIEW | Remove after go-live; demo login stays off (`NODE_ENV=production`) |
| Stale open attempts finalised by the sweeper at deploy | Q3 | 0 | 0 from 0001 | REVIEW | Inform teachers if a 0002 database ever gets 0003 later |
| Far-future dates vs TIMESTAMP 2038 | M11 | 2 (test data) | 0 | REVIEW | Keep "no deadline" as NULL |
| Server time zone not UTC | P0, R9 | UTC+4 (handled) | Unknown | BLOCKER if R9 fails | App forces UTC sessions; R9 verifies after first login |

Required migration changes: **none** based on the rehearsal. Conditional: if L1/L6/L7 find extra tables, 0002
must be extended before production; if L4/L5/L8 identify hidden teachers, the decision is data (appRole) not code.

## 6. Concurrency report

Real-MySQL integration tests (`server/integration/sessions.it.ts`):

- two tabs starting at once share one attempt, one progress row and one attempt count;
- a burst of parallel starts through the API stays idempotent;
- parallel starts after a finished attempt create exactly one next attempt;
- parallel starts never exceed the attempt limit;
- a finished attempt can never get a second result;
- an older autosave retry never overwrites a newer answer (revision check); `answeredCount` stays in step.

Browser: EXAM-01 (double-click Start → 1 attempt), EXAM-05 (double-click final submit → 1 result).

Bugs found and fixed during this phase:

| Bug | Fix |
| --- | --- |
| Concurrent start surfaced an internal error: drizzle wraps `ER_DUP_ENTRY`, so the duplicate-key check missed it | `isDuplicateKey` walks the error `cause` chain (`server/modules/attempts.ts`) |
| Autosave racing submit could store an answer the graded result did not reflect | `saveAnswers` locks the attempt row (`SELECT … FOR UPDATE`) and rechecks status |
| `DEFAULT now()` timestamps were shifted by the server offset (UTC+4) | Every pooled connection sets `time_zone = '+00:00'` (`server/db.ts`) |

## 7. Expiry report

Integration tests: expired session with saved answers auto-submits once and is graded from saved answers; zero
answers → `EXPIRED_NO_ANSWERS` without a result; submit just after the deadline is recorded as auto-submitted at
the deadline; submit racing the sweeper and concurrent sweepers produce one result; autosave after the server
deadline is rejected and the saved answer kept; a ping after expiry closes the session instead of extending it;
heartbeats keep the page-open signal but do not reset inactivity.

Browser: EXP-01 reopening after the deadline auto-submits; EXP-02 on-screen expiry locks controls then opens the
result; EXP-03 no answers → clear state for student and teacher; EXP-04 background sweeper finalised 28 s after
the deadline with no browser open (interval 30 s); EXP-05 late change rejected (`ATTEMPT_CLOSED`), saved answer
kept. Interrupted students are never marked failed: saved answers are graded, empty sessions are labelled
separately.

## 8. Authorization report

Integration tests (`server/integration/authorization.it.ts`, 15 tests): teacher A cannot read or mutate teacher
B's assessments, reports, exports, results, grading, groups, memberships, analytics, activity, assignments or
materials, and cannot assign work to B's groups/students; the workspace header cannot grant access; student A
cannot reach student B's results, sessions, answers, or assessments of groups they are not in; partners see no
teaching/student data; users without active membership cannot open/start assessments; users without a workspace
cannot use teacher endpoints.

Error convention, consistent across procedures: no context → 403 `NO_WORKSPACE` / `PARTNER_ONLY`; foreign
resource id → `NOT_FOUND` (existence is not revealed); not assigned → `NO_ACCESS`. Browser: CTX-03 (spoofed
workspace rejected, UI recovers to own workspace), CTX-05 (pending partner, UI + API), CTX-06 (student → teacher
pages/APIs), AUTH-07 (forged cookie = signed out).

## 9. Browser smoke report

Full table (name, result, route, viewport, browser, screenshots, issues, console errors):
[`browser-smoke-results.md`](browser-smoke-results.md). Tool: `scripts/browser-smoke.mjs` (refuses non-local
URLs and non-test databases). Browser: Chromium 141.0.7390.37 headless via Playwright installed in `~/.tools`
(not a repo dependency). Viewports: 1366×900 desktop, 390×844 phone (touch, DPR 2). Locale az-AZ, Asia/Baku.

Areas: auth (8), context (6), assessment (6), tracking (3), expiry (5), mobile (4), not applicable (3).
Console errors recorded are expected ones (`Please login` right after sign-out, `ATTEMPT_CLOSED` for the late
answer, an aborted fetch during the CTX-01 redirect).

An earlier exploratory pass used the shared Cursor browser tab; it was replaced by the isolated headless browser
after manual clicks in the shared tab interfered with the run.

| Finding | Status |
| --- | --- |
| Phone: 7 px horizontal scroll on teacher pages (`Panel` could not shrink) | **Fixed** (`min-w-0`, `client/src/components/AppShell.tsx`) |
| Dates render as "2026 M09 29" (Chrome's `az-AZ` medium date style) | Unresolved — needs a format decision |
| Mixed language when English is selected (hard-coded Azerbaijani strings) | Unresolved |
| Long activity-card labels truncated at narrow widths | Unresolved |
| Scroll position not reset on route change | Unresolved |
| `Link` wrapping `Button` (nested interactive elements) | Unresolved |
| Selected multiple-choice option not exposed to assistive tech (`aria-pressed`) | Unresolved |
| Returning to the session page counts as activity | By design (first ping after load = interaction) |
| Theme selector exists from the paused theme work | Not QA'd; dark mode not claimed |
| Real Google login / account linking | N/A locally; production step 9 |

## 10. Screenshots

39 PNG files in [`screenshots/`](screenshots/), named after the test id (e.g. `exam-03-resumed.png`,
`mob-04-participants.png`). Examples:

![Teacher dashboard with an inactive session](screenshots/trk-01-dashboard.png)
![Exam session on phone](screenshots/mob-03-session.png)

## 11. Temp-file cleanup report

| File | Action | Reason |
| --- | --- | --- |
| `.codemod-colors.cjs` | Deleted | Untracked, unreferenced helper from the paused theme codemod (already applied) |
| `.colors.txt` | Deleted | Untracked output of the same codemod |
| `vite.config.ts.bak` | Kept, recommend deleting | Pre-existing template backup, git-ignored (`*.bak`), not created in this phase |

Repository root now contains only project files. Tools and data live outside the repo (`~/.tools`:
MySQL, Node, Playwright, persona tokens).

## 12. ESLint proposal (not applied)

Facts: no ESLint config or `lint` script exists. Prettier is configured, but `pnpm format` would rewrite 87 of 153
files; changing Prettier options makes it worse (126–130 files) because `components/ui` already follows the
current config.

Proposal:

1. Add dev dependencies `eslint@9`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `globals`.
2. Minimal flat config, no stylistic rules:

   ```js
   // eslint.config.js
   import js from "@eslint/js";
   import tseslint from "typescript-eslint";
   import reactHooks from "eslint-plugin-react-hooks";
   import globals from "globals";

   export default tseslint.config(
     { ignores: ["dist/**", "client/src/components/ui/**", "client/public/**", "drizzle/meta/**"] },
     js.configs.recommended,
     ...tseslint.configs.recommended,
     {
       files: ["client/**/*.{ts,tsx}"],
       languageOptions: { globals: globals.browser },
       plugins: { "react-hooks": reactHooks },
       rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
     },
     { files: ["server/**/*.ts", "scripts/**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.node } },
     {
       rules: {
         "@typescript-eslint/no-explicit-any": "warn",
         "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
       },
     },
   );
   ```

3. Script `"lint": "eslint ."` — report only, no `--fix`. Fix only errors (hooks rules) in the first PR.
4. Formatting: one separate formatting-only commit later (`pnpm format`), with nothing else in it, at a quiet
   time; then add `prettier --check` to CI.

## 13. Updated production migration checklist

The runbook [`docs/migrations/0002-production-runbook.md`](../migrations/0002-production-runbook.md) now covers
0002 + 0003 together and maps the 13 production steps:

| # | Step | Runbook |
| --- | --- | --- |
| 1 | Maintenance window seçilir | Go / No-Go (60 min + 60 min rollback reserve) |
| 2 | Production DB full backup alınır | B1–B3 (`mysqldump --single-transaction`, sha256, host snapshot) |
| 3 | Backup restore test edilir | B4 (restore to scratch, L1–L3 must match) |
| 4 | Read-only preflight audit işlədilir | A (pack section pre-0002, restored copy first) |
| 5 | Data count report alınır | L3/L4 → ticket |
| 6 | Migration preview yoxlanır | A0 (migrate the restored copy, D + M + R, schema inspect, both rollbacks) |
| 7 | Migration işlədilir | C (`pnpm db:migrate`, never `db:push`) |
| 8 | Post-migration reconciliation query işlədilir | D1–D8 + M1–M11 + R1–R8 |
| 9 | Google login test edilir | E + R9 time-zone check |
| 10 | Teacher/student context test edilir | E |
| 11 | Existing assessment/result test edilir | E |
| 12 | Monitoring açılır | E monitoring (24 h, status counts, sweeper, M9/M10) |
| 13 | Rollback qərarı üçün vaxt pəncərəsi saxlanılır | F decision window (24 h) |

Changes in this phase: 0003 steps, audit-pack ids replacing A1–A9, preview on the restored copy, time-zone
check, rehearsal/inspect commands, rollback via the two reviewed SQL files (the old inline F2 deleted the
journal row with `ORDER BY … LIMIT 1`; the files delete by exact `created_at`), partial-failure handling for 0003.

## 14. Backup plan

- Immediately before migrating, with the old app stopped: `mysqldump --single-transaction --routines --triggers
  --hex-blob --set-gtid-purged=OFF --default-character-set=utf8mb4`, plus sha256 checksum.
- Additionally a host-level snapshot if Railway offers one.
- Restore test into a scratch database before the window (B4) and again as part of the preview (A0).
- Two storage locations outside the database host; kept at least 30 days (runbook G).
- Rehearsed: dump → restore → identical row counts and schema (`resulio_rh_restore_test`).

## 15. Rollback plan

| Situation | Action |
| --- | --- |
| Migration or reconciliation failed, no new writes | F1: restore the backup, verify L1–L3, redeploy previous version (preferred) |
| 0003 app served traffic, keep 0002 | F2: `0003-rollback.sql` (data kept in `_rollback_0003_*`), 0002-compatible build |
| New app served traffic, return to legacy schema | F3: export new tables, `0003-rollback.sql`, then `0002-rollback.sql` |
| `db:migrate` failed part-way | F4: stop, inspect journal/tables, restore backup |

Decision window: 24 hours with the crew and backup available. Triggers: BLOCKER reconciliation failure, legacy
teacher without workspace, duplicate user on Google login, lost answers/results, R9 time shift, sustained
`INTERNAL_ERROR`s. Both scripts are exercised by `pnpm db:rehearse`.

## 16. Post-migration reconciliation queries

All in `docs/migrations/legacy-audit-queries.sql` (plus D1–D8 in the runbook):

- counts: R2 = Q1 baseline (from 0001: users unchanged, workspaces = number of legacy teachers, rest 0);
- journal: R1 = 4 rows, last `created_at` 1790701222563;
- backfill: R3 all zeros; progress: R4 rows = pairs, zeros elsewhere; defaults: R5 zeros;
- structure: R6 enum, R7 five indexes, `inspect-schema --expect-legacy` = `0003_snapshot`;
- integrity: M2–M10 empty (M5 may list students who left a group — expected), R8 empty;
- time zone: R9 after the first smoke-test login.

## 17. Recommended next task

Per the roadmap, the next step is **theme token implementation** (roadmap 7), started only after your explicit
approval, followed by theme visual QA. Two small decisions would help before or alongside it:

1. Date format for Azerbaijani: numeric `29.09.2026, 21:34`, or custom month names (`29 sentyabr 2026`).
2. In parallel (ops, no code): obtain a restored copy of the production backup so the pre-0002 audit section can
   run there and the hidden-teacher decisions (L4/L5/L8) can be made before the production migration plan
   (roadmap 9).

The unresolved UI findings in section 9 (language mix, truncation, scroll reset, `Link`/`Button` nesting,
`aria-pressed`) are small and can be scheduled with the theme QA pass.
