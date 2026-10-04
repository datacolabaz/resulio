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
3. `pnpm db:migrate` — apply the checked-in migrations in `drizzle/`. The server also applies pending migrations itself on every start (`AUTO_MIGRATE=0` turns that off); see [RAILWAY.md](RAILWAY.md#automatic-migrations).
4. Optional: `pnpm db:seed` — demo teacher/student, a group and a published assessment (refuses to run in production unless `ALLOW_SEED=1`). In development the home page then shows demo login buttons.

## Sign-in

Google is the primary sign-in; email + password is the secondary option under it (no extra env vars, needs migration `0017_user_password_hash`). Both end in the same session cookie, referral/`?src=` attribution and return URL (`server/_core/authSession.ts`).

- Passwords: scrypt via Node's built-in crypto (`server/_core/password.ts`), min 8 characters; one generic error for unknown email or wrong password; rate-limited per IP and per email.
- Sign-up refuses any email that already has an account. An existing Google user adds a password in **Settings** (needs a sign-in within the last hour, or the current password to change it).
- Google sign-in for an email that has a password-only account links to that same user and drops the password, because sign-up does not verify email ownership; the user gets a notification and can set a new one in Settings.
- There is no "forgot password" email yet. Users whose email is a Google account recover by signing in with Google and setting a new password; anyone else needs an admin. Emailed reset links can be built on the Resend module (see **E-mail** below).

## AI provider

AI question generation and submission pre-review call any OpenAI-compatible `chat/completions` API (`server/_core/aiConfig.ts`). They stay off until a key is set. On Railway, add these to **resulio-api**:

| Provider | Variables | Key |
| --- | --- | --- |
| OpenAI | `AI_API_KEY=sk-...` (optional: `AI_API_URL=https://api.openai.com/v1`, `AI_MODEL=gpt-4o-mini`) | https://platform.openai.com/api-keys |
| Google Gemini (free tier) | `AI_API_KEY=...`, `AI_API_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `AI_MODEL=gemini-3.8-flash` (or `gemini-3.5-flash-lite`; `gemini-2.0-flash` is shut down and `gemini-2.5-flash` is closed to new projects) | https://aistudio.google.com/apikey |

- `AI_API_URL` works with or without `/v1`; `/v1` is added only when the URL has no version segment. Empty = OpenAI. `AI_MODEL` empty = `gpt-4o-mini` (`gemini-3.8-flash` for the Gemini URL). A failed AI pre-review logs the provider's HTTP status and error text as `[aiReview] model request failed` in the resulio-api logs.
- `AI_REVIEW_MODEL` overrides the model for pre-review only; `AI_REVIEW_DISABLED=1` turns pre-review off; `AI_REVIEW_DAILY_LIMIT` caps it per workspace (default 100/24h).
- Without `AI_API_KEY` the legacy `MANUS_API_URL` / `MANUS_API_KEY` pair is used if both are set.
- The unused voice-transcription helper uses the same provider's `audio/transcriptions` (OpenAI has it, Gemini's compatible API does not).
- What the AI sees (`server/modules/aiContext.ts`): task title, description, the teacher's hidden answer key, the text of the teacher's attached files (questions, datasets), then the student's work — teacher and student parts in separate delimited blocks, the student part treated as untrusted. Spreadsheets (.xlsx/.csv) are read cell by cell: `Sheet1!B8: =COUNTIF(B2:B6,"*Pro*") → 3` for formulas (with the value they showed), `Sheet1!B9: 3` for typed values, and data tables as compact grids. Over 60 000 characters, dataset rows are shortened first (header + first rows + count), then teacher files, then the student's text; the answer key and task text are kept.
- Default grading: the final answers are compared with the answer key; a correct answer typed without a formula gets full points plus a tip to use formulas, unless the answer key says formulas are required. Feedback is in the student's language and starts with the per-item result (e.g. "10/10 doğru").
- **Answer key** (task form, "Cavab açarı / qiymətləndirmə meyarları (tələbə görmür)"): stored in `task_answer_keys` (migration `0025`) and only ever read by teacher endpoints and the server-side AI review. **AI ilə cavab açarı hazırla** drafts it from the form's title, description and files for the teacher to check and save (20 drafts per workspace per day). If auto-grade is on and a task gets a submission without a key, the AI drafts one once, grades every student with it, and notifies the teacher; the task shows **AI layihəsi — yoxlayın** until the teacher saves the form. Until `0025` is applied the field is disabled and grading works without a key.
- Submissions without a pre-review (e.g. from before the feature) get an **AI ilə yoxla** button. **Yenidən yoxla** runs at once unless a run is still pending (then after 10 minutes); at the daily cap it is refused instead of replacing an existing review.
- The workspace owner gets in-app notifications (`server/modules/aiAlerts.ts`, in their UI language) at 80% of the daily cap and when it is reached (each at most once per 24 h per workspace), and when the provider answers 401/403 (bad key) or 429 (quota) (at most once per 6 h per type per workspace). Settings shows the last 24 h usage per workspace.

## E-mail (Resend)

`server/_core/email.ts` sends through Resend's HTTP API (reusable for future e-mails such as password reset). Without `RESEND_API_KEY` nothing is sent (logged once at info level). On Railway, add to **resulio-api**:

- `RESEND_API_KEY` — from https://resend.com/api-keys
- `EMAIL_FROM` — e.g. `Resulio <noreply@resulio.co>`; the domain must be verified in Resend (https://resend.com/domains)
- `APP_PUBLIC_URL` — optional, origin for links (default `https://resulio.co`)

Current e-mail: when a teacher clicks **Yadda saxla və tələbəyə göstər**, the student gets "your task was graded" with the task title, score and a link to `/student/assignments` — never the feedback text. A later change of the released score sends an "updated" e-mail; re-saving the same score sends nothing (`grade_email_log`, migration `0022`; alerts dedupe in `notification_dedupe`, same migration). Until `0022` is applied, alerts and e-mails are skipped (logged) and everything else keeps working. Language: the student's saved UI language (AZ/EN/RU), default AZ. Sending happens after the save, with a 10 s timeout, and never fails the grading request.

**Automatic AI grading** (per task, **AI avtomatik qiymətləndirsin**, on by default): when the AI review finishes cleanly, its score and feedback are released to the student at once, labelled "AI tərəfindən qiymətləndirilib", with one "result ready" e-mail/in-app notice. Empty or unreadable work, failed checks (e.g. someone else's file), suspected prompt injection, or a failed/skipped AI review go to the teacher instead ("Müəllim yoxlaması gözləyir"). Late work is graded. A teacher's edit always wins and sends one "updated" notice; **Yenidən yoxla** never overwrites a teacher grade. Needs migration `0024`; until then the teacher grades as before. Details: `docs/NOTIFICATIONS.md`.

All of these go through one dispatcher with a delivery log, retries and per-user preferences (Settings → Notifications); mobile push is prepared but off. See [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md).

## File storage

Uploads (task attachments, materials, submissions; max 8 MB) are stored in MySQL, base64 in the `files` table (`server/modules/files.ts`), and served by `GET /api/files/:id`. No S3 or `MANUS_*` variables are involved; `server/storage.ts` and `server/_core/storageProxy.ts` are unused Manus template code.

## Scripts

- `pnpm dev`: development server; honors `PORT` (default 3000).
- `pnpm build` / `pnpm start`: build and serve `dist/index.js` and `dist/public/`.
- `pnpm db:migrate`: apply checked-in migrations. `pnpm db:generate`: create a new migration after editing `drizzle/schema.ts`. `pnpm db:push` runs both. Hand-written migrations need `--> statement-breakpoint` between statements and a journal `when` newer than the previous entry (both checked by `server/_core/autoMigrate.test.ts`).
- `pnpm check` / `pnpm test`: TypeScript and vitest.

## Structure

- `server/modules/engine.ts` — pure grading, access rules, deadlines, result visibility and analytics helpers (no DB).
- `server/modules/*` — groups, assessments (drafts, immutable published versions, assignments), attempts (start, autosave, submit, auto-submit sweeper), analytics, AI question drafts.
- `server/routers.ts` — tRPC API. There are no global Student/Teacher roles: one `users.id` has activity contexts derived from records (`server/modules/access.ts`). Teaching requires owning a `provider_workspaces` row (the `x-resulio-workspace` header is only a hint), learning requires `group_members`, partner requires an APPROVED `partner_profiles` row, admin requires `platform_roles` ADMIN.
- `client/src/pages/teacher`, `client/src/pages/student` — teaching and learning areas (`/teacher`, `/student`), switched from the avatar menu; the exam session is `/student/sessions/:attemptId`. Onboarding is `/welcome`.

Tasks, materials, AI drafts and notifications are still kept in memory (`server/resulioStore.ts`) and are lost on restart.
