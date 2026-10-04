# Railway deploy

> Superseded for production by [`docs/deployment/railway-deployment-plan.md`](docs/deployment/railway-deployment-plan.md)
> (two services: `resulio-frontend` on resulio.co, `resulio-api` on api.resulio.co). The steps below describe the
> original single-service setup and must not be used for the production cut-over.

This app has a production `Dockerfile` (`pnpm build` then `node dist/index.js`) and a health check at `/api/health`.

1. Create a Railway project and add a MySQL plugin.
2. Copy variables from `.env.example` into Railway Variables. Set `DATABASE_URL` from the plugin, a random `SESSION_SECRET` (32+ chars), and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. In Google Cloud Console add the authorised redirect URI `https://<service>.up.railway.app/api/auth/google/callback` (or set `GOOGLE_REDIRECT_URI` explicitly).
4. Migrations are applied automatically when the server starts (below). `DATABASE_URL=<railway url> pnpm db:migrate` still works by hand.
5. Deploy from this repository root (Dockerfile builder).
6. Open `https://<service>.up.railway.app/api/health` and confirm `{"status":"ok","migrations":{"state":"applied" or "up_to_date",...}}`, then sign in with Google.

Demo login is always disabled when `NODE_ENV=production`; Google is the only sign-in method there.

## Automatic migrations

On every start, before it accepts requests, the API server (`server/_core/autoMigrate.ts`) applies the pending
migrations in `drizzle/` with drizzle-orm's migrator — the same `__drizzle_migrations` history `pnpm db:migrate`
uses, so a database migrated either way is compatible. The `drizzle/` folder ships in the Docker image
(`.dockerignore` does not exclude it). A MySQL lock (`GET_LOCK('resulio_migrations', 60)`) makes concurrently
starting instances migrate one at a time. Set `AUTO_MIGRATE=0` to turn it off.

Deploy log lines (Railway → service → Deployments → logs):

| Line | Meaning |
|---|---|
| `[Migrations] Applying N pending migration(s): …` then `[Migrations] Applied N migration(s); database schema is up to date (latest: 00xx_…).` | Migrations ran and succeeded |
| `[Migrations] Database schema is up to date (latest: 00xx_…).` | Nothing to do |
| `[Migrations] AUTO-MIGRATE SKIPPED: The database already has … tables but no migration history …` | See "Missing history" below. Nothing was changed |
| `[Migrations] AUTO-MIGRATE FAILED: 00xx_… failed: <MySQL error> …` | A migration failed. The server keeps running (features needing the new tables stay off); fix the database (restore the backup or finish the migration by hand), then redeploy |

`GET /api/health` shows the same outcome as `migrations.state` (`applied`, `up_to_date`, `skipped_untracked`,
`failed`, `disabled`, `no_database`) and `migrations.latest`. The health check itself stays 200 either way.

**Missing history.** If the database already has tables but no `__drizzle_migrations` rows (it was created with
`drizzle-kit push` or manual SQL), replaying every migration from `0000` would fail, so the server skips migrating.
To fix it once:

1. Back up the database.
2. Find the newest migration whose changes (and every earlier one's) are already in the database, e.g. by checking for its table/column
   (`0015_share_event_visitor` adds `share_events.visitorId`, `0017_user_password_hash` adds `users.passwordHash`,
   `0025_task_answer_keys` creates `task_answer_keys`, `0026_syllabus_core` creates the `syllabus_*` tables). Tags are
   the file names in `drizzle/` without `.sql`.
3. Set the Railway variable `AUTO_MIGRATE_BASELINE=<that tag>` (e.g. `0014_add_share_event_downloaded`) and redeploy.
   The server records `0000…<tag>` as applied (same hash/timestamp drizzle would store) and applies the rest. The
   log shows `[Migrations] Baseline: recorded N migration(s) up to <tag> as already applied`.
4. Remove `AUTO_MIGRATE_BASELINE` afterwards (it is ignored once history exists).

If the Railway health-check timeout is short, allow at least 2 minutes: a waiting second instance can hold the
lock for up to 60 s before it starts.
