# AI Study Coach

A private study loop for students: upload your own material → read a short summary and key
concepts → practise → see your mistakes → review → ask the tutor. Everything lives in side tables
prefixed `coach_*`; the coach never writes teacher tables (groups, exams, attempts, results,
syllabus, question bank) and never changes a teacher's grades.

## Access

Feature flag `study_coach`, **off by default**. It turns on for a student when any of these holds:

1. env `STUDY_COACH_ENABLED_USERS` lists the user id (or `*`), or `STUDY_COACH_ENABLED_WORKSPACES`
   lists the workspace of one of the student's active groups (or `*`);
2. a `feature_flag_overrides` row `USER` for the student (on or off — it wins);
3. a `WORKSPACE` override that is on for one of the student's group workspaces;
4. the global `feature_flags` row `study_coach`.

Students without any group are covered by 1 (`*`), 2 and 4. Rollout: pilot users first
(`STUDY_COACH_ENABLED_USERS=12,34`), then everyone (`feature_flags.study_coach = 1`).

Before first use the student sees a privacy notice (what is stored, who sees it, how to delete it,
only necessary data). It is linked from the coach settings page (`/student/coach/settings`).
Accepting it is stored as `coach_settings.consentAt`; coach actions are closed until then.

## Language of generated content

Generated text (summaries, concepts, questions, feedback, tutor replies, recognition warnings) is
written in the **language the user selected in the app** (AZ/RU/EN), not the material's language.
The client sends its current locale with every generation call (fallback: the user's saved
`preferredLocale`); every prompt carries `languageRule(locale)`; cached artifacts are keyed per
locale (the locale is part of `inputHash`), so switching language regenerates once and then reuses
the cache. Quoted excerpts and citations stay verbatim in the original language.

## Models

| Role | Used for | Setting |
| --- | --- | --- |
| main | summaries, questions, tutor, first-pass grading | `COACH_MODEL` |
| lite | topic names, segmentation | `COACH_LITE_MODEL` |
| pro | hard open-answer grading only | `COACH_PRO_MODEL` |
| ocr | scanned pages and images | `COACH_OCR_MODEL` |

Order: platform setting `coach.models` (admin, takes effect at once) → env → `AI_MODEL`. Empty roles
fall back to `main`. Every call is logged in `ai_request_logs` with feature `COACH_*`, the student
as `userId` and no workspace.

## Quotas (free beta)

Counted per student over `COACH_*` features only — a teacher's AI quota is never touched, and coach
calls never count against a teacher.

| Setting (`platform_settings`) | Default |
| --- | --- |
| `coach.studentMonthlyTokenQuota` | 500 000 tokens / month |
| `coach.studentDailyActionCap` | 30 AI actions / day |
| `coach.limits.tutorPerDay` | 40 tutor messages / day |
| `coach.limits.uploadsPerDay` | 5 uploads / day |
| `coach.limits.maxMaterials` | 20 materials |
| `coach.limits.ocrPagesPerMaterial` | 30 recognised pages per material |
| `coach.limits.ocrPagesPerMonth` | 200 recognised pages per month |
| `coach.limits.quizzesPerDay` | 10 quizzes / day |
| `coach.limits.proGradesPerDay` | 5 second-opinion gradings / day |

`null` = the default above, `0` = unlimited. An admin's per-user override in the AI limits page
(`ai_teacher_limits`, keyed by user id) wins for that student. File limits: 8 MB, 150 pages.

## Tables

| Table | Migration | Purpose |
| --- | --- | --- |
| `coach_settings` | 0052 | recall mode, reminders, privacy notice acceptance |
| `coach_events` | 0052 | event log (also used for per-day caps) |

All migrations use `CREATE TABLE IF NOT EXISTS`; every identifier (tables, columns, indexes,
generated primary-key names) is at most 64 characters — `pnpm db:verify` and
`server/migrationIdentifiers.test.ts` fail otherwise.

## Errors

`COACH_NOT_AVAILABLE` (flag off), `COACH_DB_NOT_READY` (migration not applied yet),
`COACH_CONSENT_REQUIRED`, `COACH_MONTHLY_LIMIT`, `COACH_DAILY_LIMIT`, `COACH_FEATURE_LIMIT`,
`COACH_AI_BUSY` (provider rate limit), `AI_INVALID_OUTPUT`, `AI_UNAVAILABLE`.
