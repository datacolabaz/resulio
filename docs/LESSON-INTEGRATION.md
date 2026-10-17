# Online dərs və qeyd inteqrasiyası (online lesson + recording integration)

A teacher connects their Google Meet or Zoom account, schedules a lesson for a group and/or
individual students, and Resulio creates the meeting on that provider automatically. Students get
a gated join link rather than the provider's raw URL. The point of the feature: the transcript,
recording and (where the provider offers one) AI summary are rescued into Resulio's own storage
before the provider's own retention window closes it off -- Google Meet deletes a meeting's
transcript/recording artifacts roughly 30 days after the call.

## Architecture at a glance

| Piece | Where |
| --- | --- |
| DB schema (9 tables, side-schema file like `mcpSchema.ts`) | `drizzle/lessonSchema.ts` |
| Shared enums, zod input, pure helpers (join window, recurrence, retention math) | `shared/lessonIntegration.ts` |
| OAuth connect/disconnect flow (PKCE + signed state, mirrors `server/_core/googleAuth.ts`) | `server/lessons/oauthRoutes.ts`, `oauthState.ts`, `tokenStore.ts`, `tokenCrypto.ts` |
| Provider API clients (token exchange/refresh, create meeting, read transcripts) | `server/lessons/providers/googleMeet.ts`, `providers/zoom.ts` |
| Lesson CRUD, notes, student/teacher views, GDPR consent | `server/lessons/service.ts`, `router.ts` |
| External meeting creation + retry | `server/lessons/meetings.ts`, `sweepers.ts` |
| The one gated door to the provider's real join URL | `server/lessons/joinRoute.ts` (`GET /api/lessons/:id/join`) |
| Zoom's inbound webhook (`recording.completed`) | `server/lessons/webhooks.ts`, `webhookRoutes.ts` |
| Google Meet transcript rescue (polled, Meet has no webhook) | `server/lessons/captureSweeper.ts` |
| Notifications (`LESSON_SCHEDULED`) | `server/notifications/{events,templates,render}.ts` |
| Client UI | `client/src/pages/teacher/{LessonsPage,LessonDetailPage}.tsx`, `client/src/pages/student/{StudentLessons,StudentLessonDetail}.tsx`, `client/src/components/lessons/*` |

Students never receive a provider's raw `joinUrl`/`hostUrl` through any tRPC call -- only through
`GET /api/lessons/:id/join`, which re-checks `lessonJoinDecision` (`server/lessons/access.ts`)
against live DB state before redirecting, so a link copied out of the browser's network tab is
useless once the window closes or the lesson is cancelled.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `LESSON_TOKEN_ENCRYPTION_KEY` | 32 bytes, hex (64 chars) or base64. AES-256-GCM key for the OAuth tokens stored in `teacher_meeting_connections`. **Required** before any teacher can connect a provider -- generate with `openssl rand -hex 32`. |
| `GOOGLE_MEET_CLIENT_ID` / `GOOGLE_MEET_CLIENT_SECRET` | OAuth client for the Meet connect flow. Falls back to `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (the sign-in app) if unset, but a dedicated client is recommended since the scopes differ. |
| `GOOGLE_MEET_REDIRECT_URI` | Optional override; defaults to `https://<host>/api/lessons/oauth/google-meet/callback`. |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | OAuth app credentials (Zoom Marketplace → "OAuth" app type, user-managed). |
| `ZOOM_REDIRECT_URI` | Optional override; defaults to `https://<host>/api/lessons/oauth/zoom/callback`. |
| `ZOOM_WEBHOOK_SECRET` | The app's "Secret Token" from Zoom Marketplace → Feature → Event Subscriptions. **Required** for `recording.completed` to be ingested -- without it the webhook route returns 503. |

File storage for rescued Zoom video recordings reuses whatever `docs/FILE-STORAGE.md` has
configured (`R2_ACCOUNT_ID` etc.); see "What actually gets rescued" below for what happens when R2
isn't configured.

## Google OAuth scopes

`https://www.googleapis.com/auth/calendar.events` (create the Meet-attached Calendar event) and
`https://www.googleapis.com/auth/meetings.space.readonly` (read the conference record/transcript
back after the call) plus `openid email` (who connected). A teacher who connected before the
`meetings.space.readonly` scope was added needs to reconnect once -- until they do, transcript
capture for their lessons fails with 403 and is retried by the sweeper, same as any other
transient failure.

## Zoom webhook setup

1. Zoom Marketplace → your OAuth app → **Feature** → **Event Subscriptions** → add a subscription.
2. Event notification endpoint URL: `https://<api-host>/api/lessons/webhooks/zoom`.
3. Subscribe to **Recording → All Recordings have completed** (`recording.completed`).
4. Save; Zoom immediately sends an `endpoint.url_validation` challenge to the URL above, which the
   route answers automatically (`zoomWebhookChallengeResponse` in `providers/zoom.ts`) as long as
   `ZOOM_WEBHOOK_SECRET` is set to the same "Secret Token" shown on that page.
5. Every inbound event is recorded in `lesson_webhook_events` (status `RECEIVED` → `PROCESSED` /
   `FAILED` / `IGNORED`) regardless of outcome, for replay and audit.

## What actually gets rescued, and what doesn't (yet)

- **Zoom transcript, chat log, and AI Companion summary** (`recording_files[].file_type` =
  `TRANSCRIPT` / `CHAT` / `SUMMARY`): downloaded as text and stored inline in
  `lesson_records.textContent` as soon as the `recording.completed` webhook arrives.
- **Zoom video recording** (`file_type = MP4`): streamed straight into the configured R2 bucket
  (bypassing the 8 MB cap `saveFile` applies to browser uploads -- that cap exists for the web
  upload form, not this server-to-server rescue path) and recorded as an ordinary `files` row. If
  no object store is configured, the row is marked `UNAVAILABLE` with an explanatory `lastError`
  rather than silently losing the recording without a trace; storing a lesson-recording-sized
  video as base64 in MySQL is not a reasonable fallback.
- **Google Meet transcript**: the capture sweeper (`captureSweeper.ts`) polls the Meet API every
  30 minutes for each ended lesson's conference record, and once Meet finishes generating the
  transcript, pulls every entry's text and joins it into one plain-text document.
- **Google Meet video recording**: **not fetched in this release.** Meet recordings land in the
  host teacher's own Google Drive; reading them back would need the `drive.readonly` (or
  `drive.file`) scope on top of `meetings.space.readonly`, which hasn't been requested. A teacher
  who wants to keep the video should save it from Drive themselves before Google's retention
  window closes. (The `lesson_records` row for `RECORDING` on a Google Meet lesson is simply never
  created; only `TRANSCRIPT` is.)
- **Google Meet AI summary**: not implemented -- Meet's "Gemini notes" live in Drive/Docs the same
  way recordings do, same scope gap as above.

`daysUntilProviderDeletion` / `recordingRetentionExpired` (`shared/lessonIntegration.ts`) are what
the sweeper uses to give up and mark a still-PENDING Google Meet transcript `UNAVAILABLE` once the
30-day window has closed rather than retrying it forever.

## GDPR: recording consent

Every participant (other than the teacher who started the recording) must acknowledge a recording
notice for a given lesson before Resulio will hand them the meeting URL: `GET
/api/lessons/:id/join` checks `hasAckedConsent` and, if it's missing, redirects to the student's
own lesson-detail page instead of the provider -- that page shows the notice and an "I accept and
join" button (`trpc.student.lessons.ackConsent`) which records a `lesson_consent_acks` row and
only then lets the student actually join. Acknowledgement is per `(lesson, user)` and never
expires or needs re-acking for that lesson.

## Known follow-ups (not blocking this release)

- Google Meet video/AI-summary capture needs the Drive scope and a Drive-export step; left out
  deliberately rather than half-built (see above).
- The meeting-creation and capture sweepers both run on a plain `setInterval` inside the API
  process; on multiple API instances they'll race harmlessly (idempotent upserts/existence checks
  throughout) but duplicate the polling work. Fine at Resulio's current scale; worth moving to a
  single cron-style job if that changes.
- Zoom's cloud recording retention is governed by the teacher's own Zoom account settings and
  isn't tracked by `daysUntilProviderDeletion` (that function is Google-Meet-specific) -- Zoom
  rescue instead happens eagerly, the moment `recording.completed` fires, so there's no window to
  track.
