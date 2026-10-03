# Railway deployment plan — resulio.co / api.resulio.co

Status: **plan only**. Nothing here has been executed. No Railway service, variable, domain, DNS record,
Google OAuth setting or production database has been touched. Railway is the only host; there is no
Vercel (or other) configuration in the repository.

Target:

| Railway service | Domain(s) | Role |
|---|---|---|
| `resulio-frontend` | `resulio.co` (primary), `www.resulio.co` → 301 `resulio.co` | Built SPA, SPA fallback, host redirects |
| `resulio-api` | `api.resulio.co` | API, Google OAuth, authorization, sessions, autosave, results, analytics, activity, partner, admin, expiry sweeper |
| Railway MySQL | internal network only | Database |
| legacy | `mentorix.io`, `www.mentorix.io` → 301 `https://resulio.co{path}{query}` | Redirect only |

Branching: feature branches → Railway staging/preview environment (if one is created); `main` → Railway
production **only after explicit approval**.

---

## 1. Configuration audit (repository as of this plan)

### Frontend

| Item | Current state |
|---|---|
| Stack | Vite 7 + React 19, wouter router, tRPC client, Tailwind 4 |
| Rendering | **SPA** (no SSR). `client/index.html` → `dist/public` |
| Build | `vite build` (part of `pnpm build`); `pnpm build:static` builds the client alone |
| Output | `dist/public` (`vite.config.ts` → `build.outDir`) |
| Start | none of its own — served by the Express API process (`serveStatic`) |
| Route fallback | Express `app.use("*")` returns `index.html` for every unknown path (so refresh on `/teacher/...` works today) |
| Env prefix | Vite default `VITE_` (`envDir` = repo root). **No `VITE_` variable is used today** |
| API URL | **Relative**: tRPC `url: "/api/trpc"` (`client/src/main.tsx`), login `window.location.href = "/api/auth/google/start?..."` (`client/src/const.ts`), `<script src="/api/platform/config.js">` in `index.html` |
| Custom header | `x-resulio-workspace` on every tRPC call (forces a CORS preflight when cross-origin) |

### Backend

| Item | Current state |
|---|---|
| Runtime | Node 22 (`node:22-bookworm-slim` in `Dockerfile`); dev uses Node 24 locally |
| Framework | Express 4 + tRPC 11 (`/api/trpc`), superjson |
| Start | `node dist/index.js` (Dockerfile `CMD`; `pnpm start` equivalent) |
| Build | `pnpm build` = `vite build` + `esbuild server/_core/index.ts → dist/index.js` |
| Migration command | `pnpm db:migrate` (`drizzle-kit migrate`, reads `DATABASE_URL`). **Manual only** |
| Health | `GET /api/health` → `{"status":"ok"}` (process liveness; does not check the database) |
| Google OAuth | Backend-managed: `GET /api/auth/google/start`, `GET /api/auth/google/callback`. Redirect URI = `GOOGLE_REDIRECT_URI` or derived from request host. PKCE + nonce state cookie `resulio_oauth` |
| After login | Redirects to a **relative** path (`returnTo`, default `/app`); cancel → `/?login=cancelled` |
| CORS | **None** (same-origin only today) |
| CSRF | `csrfGuard`: non-GET `/api/*` requests whose `Origin`/`Referer` host ≠ request host are rejected; tRPC writes must be JSON |
| Session | JWT (jose, `SESSION_SECRET`) in cookie `resulio_session`: `httpOnly`, `SameSite=Lax`, `Secure` in production, **host-only** (no `Domain`), 1 year |
| Database | `mysql2` pool, `DATABASE_URL`, 10 connections, UTC |
| Background job | In-process expiry sweeper every 30 s (`startAttemptSweeper` in `server/_core/index.ts`), disabled without `DATABASE_URL` |
| Proxy | `trust proxy = 1` (correct behind Railway's edge) |
| Security headers | `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` |

### Railway-related files

| File | Content |
|---|---|
| `railway.json` | Builder `DOCKERFILE`, healthcheck `/api/health` (30 s), restart `ON_FAILURE` ×3. **No `preDeployCommand`, no start override** |
| `Dockerfile` | Single image: install → `pnpm build` → `node dist/index.js`, port 3000 |
| `RAILWAY.md` | Old single-service instructions using `*.up.railway.app` callback — superseded by this plan |
| `railway.toml`, `nixpacks.toml`, `Procfile` | none |
| `.dockerignore` | excludes `node_modules`, `dist`, `.git`, `.env*`, `.manus-logs` |
| Vercel / Netlify / GitHub Actions | none |

Environment variables read by the code: `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TEACHER_EMAIL_ALLOWLIST`, `SUPER_ADMIN_EMAILS`, `APP_ENV`,
`AUDIT_HASH_SECRET`, `DISABLE_DEMO_LOGIN`, `ALLOW_SEED`, `AI_API_URL`, `AI_API_KEY`, `AI_MODEL`,
`AI_REVIEW_*`, `MANUS_API_URL`, `MANUS_API_KEY` (+ public
`MANUS_PROJECT_ID`, `MANUS_OAUTH_PORTAL_URL`, `MANUS_API_BROWSER_KEY`), `PORT`, `NODE_ENV`.

### What cannot be seen from the repository

Railway project/services, attached domains, connected GitHub repo and branch, auto-deploy toggle, PR
environments, variables and the current production database are only visible in the Railway dashboard.
Neither the Railway CLI nor a Railway token is available here, and none was used. These must be read in the
dashboard by the owner before any step below (checklist in section 3).

---

## 2. GitHub branch

Work is pushed only to feature branches (`feat/...`); `main` is created and deployed only after approval.
The push report for each branch is part of the change record, not this file.

## 3. Deploy-risk report

| Risk | Finding | Action before any deploy |
|---|---|---|
| Push triggers deploy | Unknown. GitHub repo `datacolabaz/resulio` was **empty** (no branches) at audit time, so no Railway service can have deployed from it yet | In Railway → service → Settings → Source: note repo, branch, "auto deploy" and "PR environments" |
| `main` auto-deploys | Railway's default is to deploy the configured branch on every push | Keep production's trigger branch = `main`; disable auto-deploy on production until cut-over is approved |
| First push becomes default branch | On an empty GitHub repo the first pushed branch becomes the default; a Railway service connected later would pre-select it | Create `main` deliberately (approved) or set the default branch in GitHub after the first push |
| Migrations run automatically | **No**: no `preDeployCommand`, no migration in `Dockerfile`/`CMD` | Keep it that way (section 11) |
| One service vs two | **One** today: Express serves API + SPA | The two-service split needs the code changes in section 5 |
| Refresh on client routes | Works today (Express fallback) | Frontend service must keep an SPA fallback (section 6) |
| Railway-generated URL in API/OAuth | Code has no hard-coded URL; callback derives from the request host unless `GOOGLE_REDIRECT_URI` is set. `RAILWAY.md` suggests a `*.up.railway.app` callback | Set `GOOGLE_REDIRECT_URI=https://api.resulio.co/api/auth/google/callback` explicitly |
| Public repository | `datacolabaz/resulio` is **public**: code, migration runbooks and audit plans are world-readable once pushed | Owner decision (make private, or accept) |
| Multiple API replicas | Each replica runs its own 30 s sweeper | Start with 1 replica; prove concurrent sweeps create no double result on staging (P-9) before scaling |
| Health check depth | `/api/health` passes even if MySQL is unreachable | Add a readiness check (DB `SELECT 1`) in the split work |

---

## 4. Frontend service plan — `resulio-frontend`

Implemented:

- Railway config: `railway.frontend.json` (set as the service's config-as-code path) → `Dockerfile.frontend`,
  health check `/healthz`.
- Image: `pnpm build:frontend` (`vite build` + `scripts/build-frontend.mjs`, which bundles `server/frontend.ts`
  into one file); the runtime stage holds only `dist/public` and `dist/frontend.js`, no `node_modules`.
- Server (`server/frontend.ts`):
  1. hashed `assets/*` cached for 1 year, `index.html` `no-cache`, missing assets 404;
  2. SPA fallback (section 6), `/api/*` 404;
  3. host redirects (`server/_core/hostRedirect.ts`): `www.resulio.co`, `mentorix.io`, `www.mentorix.io` →
     `https://resulio.co{path}{query}` (301, 308 for non-GET).
- Build-time variable: `VITE_API_URL`, default `https://api.resulio.co` in `Dockerfile.frontend`; override it
  per environment (e.g. staging) with a service variable of the same name.

## 5. Backend service plan — `resulio-api`

Keeps the current `Dockerfile` and `railway.json` (health check `/api/health`). The split is switched on by
one variable, `FRONTEND_URL`; without it the API still serves the web app itself (single service, as staging
uses today).

Implemented:

1. **API base URL in the client**: `API_BASE` from `VITE_API_URL` (`client/src/const.ts`) for tRPC and the
   Google login start; `credentials: "include"` was already set.
2. **CORS** (`server/_core/cors.ts`) on `/api/*`: origins = `FRONTEND_URL` + optional `CORS_ALLOWED_ORIGINS`,
   credentials allowed, headers `content-type, x-resulio-workspace, trpc-accept`, methods `GET, POST, OPTIONS`;
   unlisted origins get no CORS headers.
3. **CSRF guard** accepts the same allowlisted origins; everything else is still rejected.
4. **Post-login redirects** go to `FRONTEND_URL + returnTo` and `FRONTEND_URL + "/?login=cancelled"`;
   `safeReturnTo` stays path-only.
5. **Cookie** stays host-only on `api.resulio.co`. `resulio.co` and `api.resulio.co` are same-site, so the
   `SameSite=Lax` cookie is sent on the SPA's credentialed requests. No `COOKIE_DOMAIN`.
6. `/api/platform/config.js` is served as a static file by the frontend.
7. With `FRONTEND_URL` set, page URLs on the API host 301 to the frontend; unknown `/api/*` paths are 404.

Verified locally with the frontend on :3001 and the API on :3000 (separate origins, local MySQL): signed-in
dashboard loads through the API, a cross-origin mutation passes preflight and CSRF, the login button targets
the API host, foreign origins get no CORS grant and are rejected by CSRF.

Still open: a readiness check (`/api/health` does not ping MySQL).

**Staging note:** two `*.up.railway.app` hosts are different sites (the suffix is on the Public Suffix List),
so browsers do not send the `SameSite=Lax` cookie between them. A split staging needs custom subdomains under
one site (e.g. `staging.resulio.co` + `api-staging.resulio.co`); otherwise keep staging single-service.

Responsibilities unchanged: all authorization stays server-side; the `x-resulio-workspace` header is only a
hint that the server re-validates.

## 6. SPA route fallback plan

- Rule: if the request path matches a file in `dist/public`, serve it; otherwise serve `index.html` with 200.
- Exclusions: `/assets/*` misses return 404 (a stale hashed chunk must not receive HTML).
- Covered routes (all client-side, from `client/src/App.tsx`): `/student`, `/student/assessments/:id`,
  `/student/sessions/:id`, `/student/results/:id`, `/teacher`, `/teacher/assessments/:id`,
  `/teacher/assessments/:id/participants`, `/teacher/groups/:id`, `/teacher/results/:id`, `/partner`,
  `/settings`, `/welcome`, `/join/:inviteCode`, `/exam/:shareCode`, `/app`. (`/admin` has no client route yet.)
- Unknown paths render the SPA's own Not Found page.
- Verify with a refresh on each listed route on staging (checklist item P-4).

**Legacy path mapping (open item).** The current routes are `/exam/:shareCode` and `/join/:inviteCode`.
Links such as `/exams/abc123`, `/results/...` or `/invite/...` from the old Mentorix app do not exist in
Resulio. A host redirect alone keeps the path, so those links would reach the Not Found page. Before
cut-over: inventory Mentorix URL patterns (from its code or access logs) and add explicit compatibility
redirects (e.g. `/exams/:code` → `/exam/:code`, `/invite/:token` → `/join/:token`) that keep the query string.

## 7. Environment variable map

### `resulio-frontend` (build-time, public)

| Variable | Value | Note |
|---|---|---|
| `VITE_APP_NAME` | `Resulio` | |
| `VITE_APP_URL` | `https://resulio.co` | |
| `VITE_API_URL` | `https://api.resulio.co` | used; default in `Dockerfile.frontend` |
| `VITE_LEGACY_DOMAIN` | `https://mentorix.io` | informational |

### `resulio-api` (runtime, secret where marked)

| Variable | Value | Exists in code today |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `APP_ENV` | `production` (staging: `staging`) | yes |
| `PORT` | set by Railway | yes |
| `DATABASE_URL` | Railway MySQL **internal** URL (reference variable) — secret | yes |
| `SESSION_SECRET` | 32+ random chars — secret; **must stay the same value** as the current production service or every user is signed out | yes |
| `AUDIT_HASH_SECRET` | random — secret | yes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | existing client — secret | yes |
| `GOOGLE_REDIRECT_URI` | `https://api.resulio.co/api/auth/google/callback` | yes |
| `SUPER_ADMIN_EMAILS` | owner e-mails | yes |
| `TEACHER_EMAIL_ALLOWLIST` | empty or list | yes |
| `APP_NAME` | `Resulio` | no (unused) |
| `FRONTEND_URL` | `https://resulio.co` | yes — turns on the split |
| `API_PUBLIC_URL` | `https://api.resulio.co` | no |
| `LEGACY_FRONTEND_URL` | `https://mentorix.io` | no |
| `CORS_ALLOWED_ORIGINS` | not needed (`FRONTEND_URL` is always allowed) | yes — extra origins only |
| `CORS_ALLOW_CREDENTIALS` | `true` | no (would be fixed in code) |
| `COOKIE_SECURE` | `true` | no (already forced in production) |
| `COOKIE_SAME_SITE` | `lax` | no (already fixed) |
| `COOKIE_DOMAIN` | leave unset (host-only) — see 5.5 | no |

On the CORS list: `mentorix.io` / `www.mentorix.io` only redirect and never call the API, and `www.resulio.co`
redirects before any page loads; listing them is harmless but unnecessary. Recommended minimum:
`https://resulio.co` (add `https://www.resulio.co` only if the redirect is ever disabled).

Set production values only after: both domains verified on Railway, SSL valid, Google OAuth updated,
staging tests passed, migration plan approved.

## 8. Google OAuth migration plan

The callback is **backend-managed**: `/api/auth/google/callback` (`server/_core/googleAuth.ts`).

1. Before cut-over, in the existing Google Cloud OAuth client (same client, so `sub` values stay identical):
   - Authorised JavaScript origins: add `https://resulio.co`, `https://www.resulio.co`; keep
     `https://mentorix.io`, `https://www.mentorix.io`.
   - Authorised redirect URIs: **add** `https://api.resulio.co/api/auth/google/callback`; **keep** the
     existing Mentorix callback(s) unchanged until the migration is finished.
   - Consent screen: add `resulio.co` to authorised domains; update app name/logo if required.
2. Set `GOOGLE_REDIRECT_URI` on `resulio-api` to the new callback.
3. Identity: `upsertProviderUser` keys on (`provider = "google"`, `providerAccountId = sub`) → same
   `users.id`; no duplicate users as long as the same Google client ID is used. Verify with one known
   account on staging against the restored production copy.
4. In-flight logins at the moment of the switch fail (state cookie lives on the old host); users simply retry.
5. After a stable period, remove the Mentorix redirect URI.

## 9. Domain / DNS checklist (when approved)

- [ ] `resulio-frontend` → Settings → Networking → add `resulio.co`
- [ ] `resulio-frontend` → add `www.resulio.co` (redirect handled by the frontend server)
- [ ] `resulio-api` → add `api.resulio.co`
- [ ] Copy the **exact** CNAME / TXT (and apex/ALIAS guidance) that Railway shows into the registrar. Never guess values
- [ ] Wait for Railway "verified" on each domain
- [ ] Wait for a valid certificate on each domain
- [ ] `curl -I https://resulio.co` → 200; `https://www.resulio.co/x?y=1` → 301 `https://resulio.co/x?y=1`;
      `https://api.resulio.co/api/health` → 200 `{"status":"ok"}`
- [ ] Legacy: move `mentorix.io` / `www.mentorix.io` to the redirecting service **last**, in the cut-over window,
      then `curl -I https://mentorix.io/login?ref=p1` → 301 `https://resulio.co/login?ref=p1`
- [ ] Lower DNS TTL a day before the cut-over

## 10. Production deployment runbook

Preconditions: sections 5 code changes merged to `main` via reviewed PR; staging passed (section 13);
approvals for migration and window recorded.

1. Freeze: announce window; disable auto-deploy on production services.
2. Backup: full `mysqldump --single-transaction --routines --triggers --hex-blob` of production; store
   off-platform with sha256; take a Railway volume snapshot if available.
3. Restore the backup into an isolated temporary MySQL; run the legacy audit query pack
   (`docs/migrations/legacy-audit-queries.sql`) there — never on production.
4. Review: teacher ownership mapping, subscription / AI-usage evidence, orphaned data. Decide mappings.
5. Rehearse 0002 → 0003 → 0004 on the restored copy; run reconciliation queries; verify rollback SQL
   (`docs/migrations/000x-rollback.sql`) and the migration journal (`__drizzle_migrations`).
6. Window opens: stop writes (scale old service to 0 or enable maintenance page).
7. Fresh backup (step 2 again, final).
8. Run migrations once, manually (section 11). Stop on the first error → rollback strategy.
9. Deploy `resulio-api` (1 replica) with production variables; wait for healthcheck.
10. Deploy `resulio-frontend`; attach domains (section 9) if not yet attached.
11. Switch `mentorix.io` to redirect.
12. Production smoke test (section 14).
13. Decision point (rollback window, e.g. 60 min): keep or roll back.
14. Re-enable auto-deploy only if desired; keep `main` protected (PR + review).

## 11. Migration command strategy

- Migrations are **never** part of a Railway build, start command or `preDeployCommand` for 0002–0004.
- Command: `pnpm db:migrate` (drizzle-kit, applies pending files in `drizzle/` in journal order), run once by an
  operator during the window, from a one-off shell with the production `DATABASE_URL` (Railway "run"/shell,
  or a trusted machine over the public proxy URL), after the final backup.
- Before: `pnpm db:verify` on the release commit (replay = snapshot), rehearsal passed on the restored copy.
- After: reconciliation queries; `SELECT * FROM __drizzle_migrations` shows exactly the expected hashes.
- Later, small additive migrations may move to a `preDeployCommand` only after a separate decision.

## 12. Rollback strategy

| Failure point | Action |
|---|---|
| Before migration | Nothing to undo; keep old service running |
| Migration fails midway | Stop; restore the final backup (rehearsal proved half-applied states are not re-run blindly) |
| Migration ok, app broken | Redeploy previous image on the old service; run `000x-rollback.sql` in reverse order (0004 → 0003 → 0002) or restore backup if data changed since |
| Frontend broken | Roll back the frontend deployment in Railway (previous deployment → Redeploy); API untouched |
| OAuth broken | Keep old Mentorix callback (still registered); point traffic back to the old service; fix redirect URI |
| Redirects wrong | Detach `mentorix.io` from the redirect service / reattach to the old service |

Decision window and owner are fixed before the window starts. Data written after cut-over is preserved by
exporting affected tables before any restore.

## 13. Pre-production (staging) checklist

Staging = a Railway environment with its own MySQL restored from the production backup, and temporary domains.

- [ ] P-1 `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm db:verify`, `pnpm db:rehearse`, `pnpm contrast`, `pnpm build` green on the release commit
- [ ] P-2 Legacy audit reviewed; mapping decisions recorded
- [ ] P-3 Migrations applied on the restored copy; reconciliation clean; rollback SQL tested
- [ ] P-4 Refresh on every route in section 6 returns the app, not 404
- [ ] P-5 CORS: preflight from the frontend origin passes; from another origin fails; no `*`
- [ ] P-6 CSRF: cross-origin POST from an unlisted origin → 403
- [ ] P-7 Google sign-in with a known existing account → same `users.id`, no new row
- [ ] P-8 Session cookie: `httpOnly`, `Secure`, `SameSite=Lax`, host-only on the API host
- [ ] P-9 Exam: start, autosave, refresh-resume, expiry auto-submit (sweeper) with 1 replica; then with 2 replicas no double result
- [ ] P-10 Legacy links: sample of real Mentorix URLs (exam, result, invite, group, material, assignment, with `utm_*` and `ref`) land on the right Resulio page with query intact
- [ ] P-11 `/api/health` and readiness behave when MySQL is stopped
- [ ] P-12 No secret or `*.railway.app` URL in the frontend bundle (`grep` the built assets)
- [ ] P-13 `scripts/browser-smoke.mjs` (adapted to staging URLs, staging DB only)

## 14. Production smoke-test checklist

- [ ] `https://resulio.co` loads; `https://www.resulio.co/…` 301 → apex with path + query
- [ ] `https://api.resulio.co/api/health` 200
- [ ] Refresh on `/teacher`, `/student`, `/student/sessions/:id` works
- [ ] Google sign-in (teacher account, student account) → correct context, same user ids as before
- [ ] Teacher: dashboard, assessment detail, participants, results, analytics load
- [ ] Student: start a test assessment in a test workspace, autosave, submit, see result
- [ ] Partner and admin pages for an authorised account; forbidden for others
- [ ] `https://mentorix.io/`, `/login`, a real exam link, a real invite link with `?ref=` → 301 to the matching Resulio URL
- [ ] No 5xx in API logs for 30 minutes; sweeper log shows runs, no errors
- [ ] Rollback decision recorded
