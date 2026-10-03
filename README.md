# Resulio.co — Exam-first Education Platform

React / Express / tRPC / Drizzle (MySQL) modular monolith.

## Setup

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `SESSION_SECRET` (32+ chars) and the Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Without those two Google vars the sign-in button returns **Google login is not configured**. In Google Cloud Console create an OAuth **Web application** client and add:
   - Authorised JavaScript origins: `http://localhost:3000` (and later `https://<your-domain>`)
   - Authorised redirect URIs: `http://localhost:3000/api/auth/google/callback` (production: `https://<host>/api/auth/google/callback`)
   Restart `pnpm dev` after saving `.env`.

   Railway (two services): set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_REDIRECT_URI=https://api.resulio.co/api/auth/google/callback` on **resulio-api**,
   not on the frontend. The public site needs `VITE_API_URL=https://api.resulio.co` at **build**
   time so the Google button calls the API. Vars on the API alone do not help if the button
   still hits `https://resulio.co/api/auth/google/start`.
2. `pnpm install`
3. `pnpm db:migrate` — apply the checked-in migrations in `drizzle/`.
4. Optional: `pnpm db:seed` — demo teacher/student, a group and a published assessment (refuses to run in production unless `ALLOW_SEED=1`). In development the home page then shows demo login buttons.

## Sign-in

Google is the primary sign-in; email + password is the secondary option under it (no extra env vars, needs migration `0017_user_password_hash`). Both end in the same session cookie, referral/`?src=` attribution and return URL (`server/_core/authSession.ts`).

- Passwords: scrypt via Node's built-in crypto (`server/_core/password.ts`), min 8 characters; one generic error for unknown email or wrong password; rate-limited per IP and per email.
- Sign-up refuses any email that already has an account. An existing Google user adds a password in **Settings** (needs a sign-in within the last hour, or the current password to change it).
- Google sign-in for an email that has a password-only account links to that same user and drops the password, because sign-up does not verify email ownership; the user gets a notification and can set a new one in Settings.
- There is no "forgot password" email: Resulio has no email provider configured. Users whose email is a Google account recover by signing in with Google and setting a new password; anyone else needs an admin. Emailed reset links need an email provider (e.g. SMTP or Resend) to be added first.

## Scripts

- `pnpm dev`: development server; honors `PORT` (default 3000).
- `pnpm build` / `pnpm start`: build and serve `dist/index.js` and `dist/public/`.
- `pnpm db:migrate`: apply checked-in migrations. `pnpm db:generate`: create a new migration after editing `drizzle/schema.ts`. `pnpm db:push` runs both.
- `pnpm check` / `pnpm test`: TypeScript and vitest.

## Structure

- `server/modules/engine.ts` — pure grading, access rules, deadlines, result visibility and analytics helpers (no DB).
- `server/modules/*` — groups, assessments (drafts, immutable published versions, assignments), attempts (start, autosave, submit, auto-submit sweeper), analytics, AI question drafts.
- `server/routers.ts` — tRPC API. There are no global Student/Teacher roles: one `users.id` has activity contexts derived from records (`server/modules/access.ts`). Teaching requires owning a `provider_workspaces` row (the `x-resulio-workspace` header is only a hint), learning requires `group_members`, partner requires an APPROVED `partner_profiles` row, admin requires `platform_roles` ADMIN.
- `client/src/pages/teacher`, `client/src/pages/student` — teaching and learning areas (`/teacher`, `/student`), switched from the avatar menu; the exam session is `/student/sessions/:attemptId`. Onboarding is `/welcome`.

Tasks, materials, AI drafts and notifications are still kept in memory (`server/resulioStore.ts`) and are lost on restart.
