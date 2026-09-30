# Resulio Admin Operations Console — audit and implementation plan

Status: **plan only, awaiting approval.** No code, schema or migration has been written for this yet.
Nothing will be deployed and no migration will run against production.

The console is an internal tool for the Resulio platform team: user support, partner approval, feature flags,
security, audit and (later) billing oversight. It is not a teacher dashboard, not an education-center or school
dashboard, and not student-facing. Student answers, private results and teacher content are not visible by
default.

---

## 1. Audit of what exists today

| Area | Current state | Consequence for the plan |
| --- | --- | --- |
| Admin authorization | `adminProcedure` in `server/_core/trpc.ts`: signed-in user + `platform_roles` row with role `ADMIN`. One check, no permissions. | Replace with a permission-based `adminProcedure(permission)`; keep the same table. |
| Platform roles | `platform_roles(userId, role enum('ADMIN','SUPPORT'), createdAt)`, unique (userId, role). Filled by 0002 from legacy `role='admin'`. `SUPPORT` is unused. | Extend the enum to the five role names (see 3.1). No second role system. |
| Admin API | `admin.partners.list`, `admin.partners.decide(id, status)` — no reason, no audit, no actor recorded. `system.notifyOwner` is admin-only. | Rebuild partner decisions with reason + audit; move `notifyOwner` under a permission. |
| Admin UI | None. `auth.me` already returns `isAdmin`. No `/admin` routes, no admin sidebar. | New `AdminShell` + `/admin/*` pages. |
| Audit log | None (no table, no helper). | New append-only `audit_logs`. |
| Security events | None. CSRF rejects, rate-limit blocks, bad OAuth state and workspace-header spoofing are refused but not recorded. | New `security_events`, fed from those existing guards. |
| Feature flags | None. | New registry + tables + server-side evaluation. |
| Account suspension | Not possible. `partner_profiles.status` has `SUSPENDED`, users have no status. | New `users.accountStatus`, enforced in the request pipeline. |
| Session revocation | Not possible: sessions are stateless HS256 JWTs valid for one year (`server/_core/sdk.ts`). | New `users.sessionsValidAfter`; tokens issued before it are rejected. |
| "Active users" | `users.lastSignedIn` only changes at login (`touchUser` is unused). | New `users.lastSeenAt`, updated at most every 5 minutes. |
| Environment | Only `NODE_ENV`; no staging notion. | New `APP_ENV` (development / staging / production) for the badge. |
| Rate limiting | In-process fixed window (`server/_core/rateLimit.ts`), single instance. | Reuse; admin endpoints get their own limits. |
| CSRF | `csrfGuard` (origin + JSON content type) on all `/api` writes, SameSite=Lax cookie. | Already applies to admin mutations. |
| Partner application | `partner.requestProfile` creates a PENDING profile with no application answers. | Add application answers and an `INFO_REQUESTED` status. |
| Referrals / commissions | Only `partner_profiles.referralCode`. No attribution of referred sign-ups, no commission data, billing not migrated. | Commission review has nothing to review yet → Admin 2, after an attribution model is approved. |
| Materials, task assignments, AI usage, notifications | In-memory store (`server/resulioStore.ts`), lost on restart. | Admin pages show "not persisted yet" instead of numbers. No storage/download metrics exist. |
| Billing | `provider_workspaces.subscriptionStatus` (default `BETA`) only. | Read-only billing view shows this field; everything else is "not available". |

---

## 2. Scope

### Admin 1 (this plan, proposed for the first implementation)

- Server-side admin authorization with SUPER_ADMIN / SUPPORT_ADMIN permissions, SUPER_ADMIN allowlist,
  Google-only admin login in production, recent-authentication check for high-risk actions.
- Account suspension, unsuspension and session revocation (SUPER_ADMIN), enforced on every protected request.
- Append-only `audit_logs` written in the same transaction as every sensitive admin action.
- `security_events` (basic sources, severity + review status, never labelled "fraud" automatically).
- Admin routes, sidebar, environment badge, overview, user search + read-only detail, Provider Workspace
  read-only inspection, partner application review, feature flags, audit log viewer, security events viewer.
- Admin role management limited to granting/revoking SUPPORT_ADMIN, with typed confirmation and audit.
  SUPER_ADMIN is granted only by an ops script, and only to allowlisted e-mails.

### Admin 2 (later)

Referral/commission review (needs an approved attribution + commission model), privacy request workflow,
support notes and support flags, account notices, platform analytics, usage/limits, read-only billing view,
group/assessment metadata lists, cross-workspace detection for foreign resource ids.

### Admin 3 (later)

Advanced support workflow, time-limited audited read-only impersonation, data export workflow, fraud review,
monitoring integrations.

### Not built (as agreed)

No "delete user" button. No hard deletes from the admin UI, no manual SQL runner, no refunds/payouts, no
payment-provider writes, no editing of student answers, results or answer keys, no impersonation, no
organization/school/center management, no marketplace moderation, no support chat.

---

## 3. Design

### 3.1 Roles and permissions

`platform_roles.role` becomes `enum('SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER')`.
Existing `ADMIN` rows become `SUPER_ADMIN` and `SUPPORT` rows become `SUPPORT_ADMIN` in migration 0004. The three
future roles exist in the enum and the permission map with **no permissions** in Admin 1 (no UI, no workflows).

One central map in `shared/adminPermissions.ts` (shared so the UI can hide what the server would refuse anyway):

| Permission | SUPER_ADMIN | SUPPORT_ADMIN |
| --- | :-: | :-: |
| `overview.view` | ✓ | ✓ |
| `users.search`, `users.view` | ✓ | ✓ |
| `users.suspend`, `users.revokeSessions` | ✓ | – |
| `workspaces.view` | ✓ | ✓ |
| `partners.view` | ✓ | ✓ |
| `partners.decide` | ✓ | – |
| `flags.view` | ✓ | ✓ |
| `flags.change` | ✓ | – |
| `audit.view` (all events) | ✓ | – |
| `audit.viewSupport` (events whose target is a user/workspace being inspected) | ✓ | ✓ |
| `security.view` | ✓ | ✓ |
| `security.review` | ✓ | – |
| `roles.manage` (SUPPORT_ADMIN only) | ✓ | – |
| `settings.view` | ✓ | – |

Nobody has a permission to read student answers, answer keys or result item content; those queries are not
part of the admin module at all. Bulk export does not exist.

### 3.2 Request pipeline for `/api/trpc/admin.*`

```text
authenticated (valid JWT, not issued before users.sessionsValidAfter)
→ account ACTIVE (suspended users get ACCOUNT_SUSPENDED everywhere except auth.me / auth.logout)
→ production: user has a Google auth_account (no demo/legacy login for admin)
→ platform_roles row with an active admin role
→ SUPER_ADMIN only if the verified e-mail is in SUPER_ADMIN_EMAILS (env allowlist)
→ role grants the procedure's permission
→ high-risk actions: login (authTime claim) newer than 60 minutes, else REAUTH_REQUIRED
→ admin rate limit (queries 120/min, sensitive mutations 20/min per admin)
→ sensitive mutation: zod-validated reason (10–500 chars), change + audit row in ONE transaction
```

Every refusal returns `FORBIDDEN` with a stable code (`NOT_ADMIN`, `ADMIN_PERMISSION`, `REAUTH_REQUIRED`,
`ACCOUNT_SUSPENDED`) and records a throttled `ADMIN_ACCESS_DENIED` security event. The UI never decides access;
hidden navigation grants nothing.

High-risk actions: suspend/unsuspend, revoke sessions, feature flag change, role grant/revoke, partner
approve/reject/suspend, security event review. They need a Google sign-in within the last 60 minutes
(`authMs` claim in the session). Re-authentication is a normal Google OAuth round trip with a `returnTo`, which
issues a new session with a fresh `authMs`; Google has no `prompt=login` mode, so no special prompt is used.

Safety rules: an admin cannot suspend themselves or revoke their own admin role; a SUPER_ADMIN cannot be suspended
from the UI (their role must be removed by ops first); the last SUPER_ADMIN cannot be removed.

### 3.3 Suspension and session revocation

- `users.accountStatus enum('ACTIVE','SUSPENDED') default 'ACTIVE'`, `users.suspendedAt`.
- Suspending sets `sessionsValidAfter = now()` as well, so every open session ends immediately.
- A suspended user can still sign in with Google and sees a neutral "Hesab dayandırılıb" page; all product
  procedures and Express routes refuse with `ACCOUNT_SUSPENDED`.
- Open exam attempts of a suspended student are not deleted; the existing sweeper auto-submits them at the
  deadline (saved answers graded, as today).
- A suspended teacher's workspace data is untouched. Whether students can still take already-assigned
  assessments of a suspended teacher is a decision (see section 8).
- Unsuspension restores access; it does not restore revoked sessions (user signs in again).
- Reasons live in the audit log (before/after status), not in the users table.

### 3.4 Audit log (append-only)

Repo convention is camelCase columns, so the proposed fields are named accordingly:

```text
audit_logs
  id               bigint auto_increment PK
  actorUserId      int NULL            (NULL = SYSTEM / ops script)
  actorAdminRole   varchar(32) NULL
  action           varchar(64)         e.g. USER_SUSPENDED, FEATURE_FLAG_CHANGED, PARTNER_APPROVED
  targetType       varchar(32)         USER | WORKSPACE | PARTNER_PROFILE | FEATURE_FLAG | PLATFORM_ROLE | SECURITY_EVENT
  targetId         varchar(64) NULL
  workspaceId      varchar(32) NULL
  userId           int NULL            affected user
  beforeJson       json NULL
  afterJson        json NULL
  reason           text NULL
  requestId        varchar(36) NULL    per-request id (new x-request-id middleware)
  ipHash           char(64) NULL       HMAC-SHA256(ip, AUDIT_HASH_SECRET)
  userAgentSummary varchar(120) NULL   browser + OS family only
  createdAt        timestamp(3) default now(3)
  indexes: (createdAt), (actorUserId, createdAt), (targetType, targetId, createdAt), (userId, createdAt),
           (workspaceId, createdAt), (action, createdAt)
```

Append-only is enforced in three layers:

1. Code: the audit module exports only `appendAudit(tx, entry)`; there is no update/delete function, and a unit
   test fails if any `update(auditLogs)` / `delete(auditLogs)` appears in `server/`.
2. UI/API: no edit or delete procedure exists.
3. Database: `BEFORE UPDATE` / `BEFORE DELETE` triggers that raise an error. **Verified risk:** on MySQL 8.4 with
   binary logging (the default) a non-SUPER user gets `ERROR 1419 … SUPER privilege and binary logging is
   enabled` when creating a trigger (tested on the disposable MySQL). The triggers therefore ship as a separate
   ops SQL file applied with a privileged account, not inside the drizzle migration. System settings show
   whether the triggers are present.

Metadata sanitising: before/after JSON uses per-action allowlists of fields. Keys such as `token`, `secret`,
`password`, `answer`, `answerKey`, `content`, `fileUrl` are rejected by a test. Deleting a user later (privacy
workflow) anonymises the user row, never the audit rows (they contain ids and hashes, not raw PII).

### 3.5 Security events

```text
security_events
  id, type, severity enum('LOW','MEDIUM','HIGH'), status enum('REVIEW_REQUIRED','REVIEWED','DISMISSED'),
  userId NULL, workspaceId NULL, ipHash NULL, details json NULL,
  occurrences int default 1, firstSeenAt, lastSeenAt, reviewedBy NULL, reviewedAt NULL
```

Admin 1 sources (all existing guards; writes are throttled — the same type + user/IP within 5 minutes
increments `occurrences` instead of inserting):

| Type | Source | Severity |
| --- | --- | --- |
| `ADMIN_ACCESS_DENIED` | admin pipeline refusal | MEDIUM (HIGH if repeated) |
| `WORKSPACE_HEADER_SPOOF` | `teacherProcedure` when the header names a workspace the user does not own | MEDIUM |
| `RATE_LIMIT_BLOCK` | first block per key per window | LOW |
| `CSRF_REJECTED` | `csrfGuard` | MEDIUM |
| `OAUTH_STATE_INVALID` | Google callback state/nonce mismatch | LOW |
| `SUSPENDED_ACCESS` | request from a suspended account | LOW |
| `ADMIN_ROLE_CHANGED`, `FEATURE_FLAG_CHANGED` | admin actions (also in audit log) | MEDIUM |

Cross-workspace attempts through foreign resource ids currently return `NOT_FOUND` without knowing that the row
exists elsewhere; detecting them needs an extra lookup per miss and is deferred to Admin 2.

### 3.6 Feature flags

- Registry in code, `shared/featureFlags.ts`: key, Azerbaijani description, default per `APP_ENV`, and whether
  the flag is locked.
- Tables: `feature_flags(key PK, enabled, updatedBy, updatedAt, createdAt)` (global state; a missing row means
  the code default) and `feature_flag_overrides(id, flagKey, scopeType enum('USER','WORKSPACE'), scopeId,
  enabled, createdBy, createdAt, unique(flagKey, scopeType, scopeId))`.
- Evaluation on the server: user override → workspace override → global row → code default; cached for 30 s in
  process and invalidated on change.
- Flags can only switch a module off or on. They never grant access: every gated procedure still runs its normal
  authorization, and a `requireFlag(key)` middleware returns `FEATURE_DISABLED` when off.
- Each environment has its own database, so flag state is per environment by construction; the page shows the
  current `APP_ENV`.
- Change = typed confirmation + reason + one transaction writing the flag and an audit row with before/after,
  actor, scope and timestamp.

| Flag | Wired to existing code in Admin 1 | Default |
| --- | --- | --- |
| `ai_question_generation_enabled` | `teacher.ai.generate` | on (dev), off (prod until AI keys are set) |
| `partner_program_enabled` | `partner.requestProfile` | on |
| `assessment_versioning_enabled`, `activity_tracking_enabled` | Core of the exam engine; turning them off would break integrity | locked on (shown, not switchable) |
| `mentor_services_enabled`, `marketplace_enabled`, `university_search_enabled`, `live_room_enabled`, `international_exam_templates_enabled`, `proctoring_enabled` | No module exists yet; the flag is registered and shown as "modul hələ yoxdur" | off |

### 3.7 Partner applications

- `partner.requestProfile` accepts application answers (channel, audience, expected referrals, proposed referral
  code), stored in `partner_profiles.applicationAnswers json`.
- Status enum gains `INFO_REQUESTED`; the applicant can update answers, which returns the profile to `PENDING`.
- Admin actions: approve, reject (reason), request more information (message), suspend (reason), reactivate
  (reason). Each writes `decidedBy`, `decidedAt` and an audit row. The status history is the audit log for
  that profile (append-only), so no separate history table.
- Self-approval is impossible: `partners.decide` requires `partners.decide`, and an admin cannot decide their
  own profile.

### 3.8 Pages (Azerbaijani labels, existing design system, current tokens)

`AdminShell` reuses the AppShell primitives (no new visual identity, no theme work). Sidebar exactly as
specified; items not built in Admin 1 stay visible but disabled with a "Mərhələ 2" badge, and their route shows
what is missing (e.g. "Materiallar hələ verilənlər bazasında saxlanılmır"). Bottom: avatar, role label,
"Məhsula keç", "Çıxış". A permanent environment badge (DEV / STAGING / PROD) sits in the header. The avatar menu
of the normal product gets an "Admin panel" item only when `auth.me` reports an admin role.

| Route | Admin 1 content |
| --- | --- |
| `/admin` | Aggregate cards only (no names). See 3.9. |
| `/admin/users` | Server-side search (name, e-mail, id) and filters (status, created/last-seen ranges, has workspace, has membership, partner status, admin role), paginated 50 per page. |
| `/admin/users/:userId` | Account summary, Google account metadata (provider, provider e-mail, linked date — no tokens exist), contexts, workspaces, memberships (group name + status), partner profile, subscription status read-only, recent attempts (assessment title, status, timestamps, answered/total — no answers, no scores), audit timeline, account status + SUPER_ADMIN actions. |
| `/admin/provider-workspaces` + `/:id` | Title, owner, created, subscription status, assessment/group/member counts, last activity; detail adds assessment/group/assignment summaries, flag overrides and audit timeline. Storage and AI usage show "hələ ölçülmür". |
| `/admin/partners/applications`, `/admin/partners` | Queue with applicant identity and answers; partner list with status history. |
| `/admin/feature-flags` | Flags, overrides, change dialog, history. |
| `/admin/audit-log` | Filters: date range, actor, action, target type/id, user, workspace. SUPPORT_ADMIN sees it only through user/workspace detail pages. |
| `/admin/security-events` | Filters by type/severity/status; SUPER_ADMIN can mark reviewed/dismissed (audited). |
| `/admin/settings` | Read-only: environment, allowlist size, audit trigger status, sweeper status, build version. |

Phones get a notice that the console is meant for desktop/tablet; the user detail page collapses sensitive
sections by default.

### 3.9 Overview metrics — what can be real now

Day boundaries use Asia/Baku (UTC+4, no DST).

| Card | Source | Admin 1 |
| --- | --- | --- |
| Total users, new today/this week | `users.createdAt` | ✓ |
| Active users today/this week | `users.lastSeenAt` (new) | ✓ from deploy onward |
| Users with learner activity | distinct users in `student_activity_events` | ✓ |
| Active Provider Workspaces | workspaces with activity events or assessment changes in 7 days | ✓ |
| Approved partners, pending applications | `partner_profiles` | ✓ |
| Assessments total / published / active | `assessments` (+ availability window) | ✓ |
| Completed today, in progress now, expired today | `results`, `attempts` | ✓ |
| Active / overdue assessment assignments | `assessment_assignments` | ✓ |
| Pending manual grading | `results.pendingReviewCount > 0` | ✓ |
| Task assignments, materials, storage, downloads | in-memory / not measured | "Hələ mövcud deyil" |
| API error rate, failed sweeper runs | in-process counters since last restart | ✓ (labelled "restartdan bəri") |
| Failed e-mails / uploads | no e-mail sending, no persisted uploads | "Hələ mövcud deyil" |
| Recent security events | `security_events` | ✓ |

No card is filled with sample or estimated numbers.

---

## 4. Schema changes — migration `0004_admin_console`

| Change | Detail |
| --- | --- |
| `users` | add `accountStatus enum('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE'`, `suspendedAt timestamp NULL`, `sessionsValidAfter timestamp NULL`, `lastSeenAt timestamp NULL`, index (accountStatus), index (lastSeenAt) |
| `platform_roles` | enum → five roles in three steps (expand to include old + new values, `UPDATE` ADMIN→SUPER_ADMIN and SUPPORT→SUPPORT_ADMIN, shrink); add `createdBy int NULL` |
| `partner_profiles` | status enum + `INFO_REQUESTED`; add `applicationAnswers json NULL`, `decidedBy int NULL`, `decidedAt timestamp NULL` |
| new `audit_logs` | see 3.4 |
| new `security_events` | see 3.5; index (status, lastSeenAt), (type, lastSeenAt), (userId) |
| new `feature_flags`, `feature_flag_overrides` | see 3.6 |

Separate files (not drizzle migrations): `docs/migrations/0004-rollback.sql`,
`docs/migrations/audit-append-only-triggers.sql` (privileged ops step), and `scripts/admin-grant.mjs`
(bootstrap: grant SUPER_ADMIN/SUPPORT_ADMIN by e-mail with a reason; SUPER_ADMIN only for allowlisted e-mails;
writes a SYSTEM audit row).

New environment variables: `SUPER_ADMIN_EMAILS` (comma-separated), `APP_ENV`, `AUDIT_HASH_SECRET`.

---

## 5. Migration risks

| Risk | Mitigation |
| --- | --- |
| DB triggers need SUPER or `log_bin_trust_function_creators=1` under binary logging (reproduced: ERROR 1419) | Triggers are a separate privileged ops step; app-level and test-level enforcement do not depend on them; settings page reports their presence |
| `platform_roles` enum rename is three non-transactional statements; the 0003 app reads `ADMIN` | Deploy code and 0004 together (same window as 0002/0003 if production is still at 0001); rollback script maps back; rehearsal covers a mid-way failure |
| Runbook checks D4/D8 compare against `ADMIN` | If production goes 0001 → 0004 in one window, D4 compares legacy admins with `SUPER_ADMIN`; runbook updated with 0004 |
| Legacy admins lose console access unless allowlisted | Intended (explicit allowlist). L4/L5 audit lists them; ops adds approved e-mails to `SUPER_ADMIN_EMAILS` |
| Session revocation changes auth for everyone (`sessionsValidAfter` check) | NULL means "no revocation"; unit + integration tests on old/new tokens; one extra column read on an already-loaded user row |
| `lastSeenAt` writes on every request | Updated only when older than 5 minutes; no write on public procedures |
| `ADD COLUMN` on `users` | MySQL 8 INSTANT add for nullable/defaulted columns; no table rebuild |
| Rollback must not destroy audit history | `0004-rollback.sql` renames the new tables to `_rollback_0004_*` instead of dropping them |
| TIMESTAMP 2038 limit | Same as existing tables; no far-future values are written |

The migration is rehearsed on the disposable MySQL (extending `pnpm db:rehearse`: 0004 forward, audit queries,
rollback, re-apply), and `pnpm db:verify` plus `inspect-schema` cover the snapshot.

---

## 6. Affected files

New:

- `drizzle/0004_admin_console.sql`, `drizzle/meta/0004_snapshot.json`, journal entry
- `docs/migrations/0004-rollback.sql`, `docs/migrations/audit-append-only-triggers.sql`
- `shared/adminPermissions.ts`, `shared/featureFlags.ts`
- `server/modules/admin/` — `overview.ts`, `users.ts`, `workspaces.ts`, `partners.ts`, `flags.ts`, `audit.ts`,
  `security.ts`, `roles.ts`
- `server/modules/featureFlags.ts` (evaluation + cache), `server/modules/securityEvents.ts` (throttled writer)
- `server/_core/requestId.ts`
- `server/admin.test.ts`, `server/integration/admin.it.ts`
- `scripts/admin-grant.mjs`
- `client/src/components/AdminShell.tsx`, `client/src/pages/admin/*` (Overview, Users, UserDetail, Workspaces,
  WorkspaceDetail, PartnerApplications, Partners, FeatureFlags, AuditLog, SecurityEvents, Settings, Planned)

Modified:

- `drizzle/schema.ts`
- `server/_core/trpc.ts` (permission-based `adminProcedure`, suspension check, security events on refusals and
  rate-limit blocks), `server/_core/sdk.ts` (`iat`/`authTime`, `sessionsValidAfter`, `lastSeenAt`),
  `server/_core/context.ts`, `server/_core/googleAuth.ts` (fresh `authMs` on every sign-in,
  invalid-state event), `server/_core/csrf.ts` (event), `server/_core/index.ts` (request id),
  `server/_core/env.ts`, `server/_core/systemRouter.ts`
- `server/routers.ts` (admin router, `auth.me` admin roles/permissions, partner application input, flag gates),
  `server/modules/partners.ts`, `server/modules/access.ts`
- `client/src/App.tsx`, `client/src/components/AppShell.tsx` (admin link in avatar menu, suspended page),
  `client/src/pages/PartnerPage.tsx` (application form)
- `scripts/migration-rehearsal.mjs`, `scripts/smoke-personas.ts`, `scripts/browser-smoke.mjs`
- `docs/migrations/0002-production-runbook.md` (0004 steps, D4 wording, trigger ops step, admin bootstrap)

---

## 7. Test plan

Unit (`server/admin.test.ts`): permission map (every procedure declares a permission; future roles have none),
reason validation, metadata sanitiser rejects secret/answer keys, no `update`/`delete` on `auditLogs` anywhere
in `server/`, flag evaluation order, JWT `sessionsValidAfter` / `authTime` handling.

Real-MySQL integration (`server/integration/admin.it.ts`):

| Group | Tests |
| --- | --- |
| Authorization | anonymous, student, teacher, approved partner and suspended admin all get refused on every admin procedure; SUPPORT_ADMIN refused on every SUPER_ADMIN mutation; SUPER_ADMIN not on the allowlist refused; demo-login admin refused with `APP_ENV=production`; direct API calls without UI get the same results |
| Audit | every sensitive action writes exactly one audit row in the same transaction (a forced failure leaves neither change nor row); before/after stored; missing/short reason rejected; with the ops triggers applied, `UPDATE`/`DELETE` on `audit_logs` fail |
| Users | SUPER_ADMIN suspends/unsuspends; SUPPORT_ADMIN cannot; suspended user blocked from teacher, student and partner procedures but can call `auth.me`/`logout`; revoke sessions rejects old tokens and accepts new ones; self-suspension and suspension of a SUPER_ADMIN refused; no hard delete path exists |
| Feature flags | SUPER_ADMIN changes a flag; SUPPORT_ADMIN and non-admins cannot; audit row written; user and workspace overrides take precedence; a flag turned on does not let an unauthorized user call the gated procedure; locked flags cannot change |
| Partner | approve creates an APPROVED profile with `decidedBy`/`decidedAt` and opens the partner context; reject/suspend require a reason; request-info → applicant update → PENDING; applicant (or admin on own profile) cannot approve |
| Roles | SUPER_ADMIN grants/revokes SUPPORT_ADMIN with audit; granting SUPER_ADMIN through the API is refused; a user cannot grant themselves anything; last SUPER_ADMIN cannot be removed |
| Security events | workspace-header spoof, admin denial, rate-limit block and CSRF reject each create or increment an event; throttling merges repeats |
| Rate limit | sensitive admin mutations return `RATE_LIMITED` after 20/min |
| Privacy (safety) | admin user detail and workspace detail responses contain no answers, answer keys or result items (response-shape test) |

Privacy request workflow and commission tests belong to Admin 2 and are listed there.

Browser smoke additions (local only): ADM-01 non-admin opening `/admin` is redirected and the API refuses;
ADM-02 SUPER_ADMIN overview + environment badge; ADM-03 user search → detail (no answers shown); ADM-04
suspend with reason → suspended user sees the notice → unsuspend; ADM-05 SUPPORT_ADMIN sees read-only UI and the
API refuses a forced mutation; ADM-06 flag change with confirmation → audit entry visible; ADM-07 partner
approve/reject; ADM-08 tablet width. Screenshots as in Phase 1a.

---

## 8. Decisions (approved 2026-09-29)

1. Enum values are renamed to `SUPER_ADMIN`/`SUPPORT_ADMIN` in 0004.
2. Legacy `role='admin'` users become effective SUPER_ADMIN only if their e-mail is in `SUPER_ADMIN_EMAILS`.
3. When a teacher is suspended, students can still take assessments already assigned to them.
4. `assessment_versioning_enabled` and `activity_tracking_enabled` are shown as locked-on.
5. Audit-log DB triggers are a separate privileged ops step; app code and tests enforce append-only regardless.

Delivery in three reviewable parts: (a) schema 0004, permissions, pipeline, suspension/revocation,
audit, security events, bootstrap script, tests; (b) AdminShell, overview, users, workspaces; (c) partners,
feature flags, audit/security pages, browser smoke.
