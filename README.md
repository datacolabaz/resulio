# Resulio.co — Exam-first Education Platform

React / Express / tRPC / Drizzle (MySQL) modular monolith.

## Setup

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `SESSION_SECRET` (32+ chars) and the Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; redirect URI `https://<host>/api/auth/google/callback`).
2. `pnpm install`
3. `pnpm db:migrate` — apply the checked-in migrations in `drizzle/`.
4. Optional: `pnpm db:seed` — demo teacher/student, a group and a published assessment (refuses to run in production unless `ALLOW_SEED=1`). In development the home page then shows demo login buttons.

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
