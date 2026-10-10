# Notifications

Every user-facing notice goes through one dispatcher:

```
domain event ──> dispatch() ──> preferences ──> outbox row per channel ──> channel adapter
                                                (notification_deliveries)   IN_APP / EMAIL / PUSH
```

Code: `server/notifications/` — `events.ts` (events and their channels), `templates.ts` (AZ/EN/RU texts),
`render.ts` (event → title/body/e-mail), `dispatcher.ts` (outbox, retries, worker), `channels.ts`
(adapters), `preferences.ts`, `push.ts` (push providers and device registry).

## Events

| Event | Recipient | Channels | Raised by |
| --- | --- | --- | --- |
| `AI_GRADE_READY` | student | IN_APP, EMAIL, PUSH | AI graded and released a submission automatically (`modules/autoGrade.ts`) |
| `GRADE_RELEASED` | student | IN_APP, EMAIL, PUSH | teacher releases a grade (`modules/tasks.ts`, `modules/gradeEmail.ts`) |
| `GRADE_UPDATED` | student | IN_APP, EMAIL, PUSH | released score changes; teacher edits an AI grade; AI rerun changes an AI score |
| `AI_LIMIT_80` | workspace owner | IN_APP, PUSH | 80% of the daily AI cap (`modules/aiAlerts.ts`) |
| `AI_LIMIT_REACHED` | workspace owner | IN_APP, PUSH | daily AI cap reached |
| `AI_PROVIDER_ERROR` | workspace owner | IN_APP, PUSH | AI provider rejected the key or hit its quota |
| `ANSWER_KEY_DRAFTED` | task's teacher | IN_APP, PUSH | AI drafted a missing answer key on the first submission (`modules/answerKey.ts`); never contains the key |
| `SYLLABUS_ACCESS_GRANTED` | student | IN_APP, EMAIL, PUSH | a grant first reaches the student, or the first version of a syllabus is published (`syllabus/notify.ts`); key `syl-access:<grantId>:<studentId>` |
| `SYLLABUS_UNLOCKED` | student | IN_APP, PUSH | lessons/modules unlocked; batched per enrollment for 2 min (persisted in `syllabus_notice_batches`, survives a restart), the first lesson and anything the student already opened are left out |
| `SYLLABUS_APPROVAL_NEEDED` | syllabus teacher | IN_APP, PUSH | a lesson, module or the whole syllabus waits for teacher approval; batched per syllabus for 2 min (persisted like `SYLLABUS_UNLOCKED`) |
| `SYLLABUS_COMPLETED` | student | IN_APP, EMAIL, PUSH | syllabus completed (once per student and syllabus, key `syl-complete:<syllabusId>:<studentId>`) |
| `SYLLABUS_AT_RISK_DIGEST` | syllabus creator | IN_APP, EMAIL (e-mail off by default) | daily after 08:00 Baku when students are at risk and the syllabus' digest is on (`syllabus/analytics.ts`); key `syl-risk:<syllabusId>:<YYYY-MM-DD>` |
| `TASK_ASSIGNED` | student | IN_APP, EMAIL, PUSH | a teacher creates a task, or an edit makes it reach new students; or a student joins a group with open tasks (`modules/taskNotify.ts`); key `task-assigned:<taskId>:<userId>` |
| `MATERIAL_SHARED` | student | IN_APP, PUSH, EMAIL (e-mail off by default) | a material becomes visible with "Tələbələrə bildiriş göndər" ticked: on save when published now, or from the 30 s sweeper at its scheduled time; an edit of a visible material tells only students it newly reaches (`materials/notify.ts`, see `docs/MATERIALS.md`); key `material-shared:<materialId>:<userId>` |
| `TASK_UPDATED` | student | IN_APP, PUSH, EMAIL (e-mail off by default) | an edit moves the deadline by ≥ 1 hour; to students the task already reached; key `task-deadline:<taskId>:<userId>:<deadlineMs>` |
| `ANNOUNCEMENT` | users in the admin-chosen audience | IN_APP, PUSH | an admin sends an announcement (`notifications/announcements.ts`, see "Admin announcements"); key `announcement:<announcementId>:<userId>` |
| `GROUP_MEMBER_JOINED` | group's workspace owner | IN_APP, PUSH | a student joined through the group's invite code/link or a single-use invite link (`modules/groupJoin.ts`): informational, key `group-join:<membershipId>` / `group-join-link:<linkId>`; or, under the APPROVAL join policy, sent a request through the code (`pending: true`, "Yeni qoşulma sorğusu", links to `/teacher/groups/<id>?tab=requests`), once per request, key `group-join-request:<membershipId>`; or, under APPROVAL, was admitted at once as a student the teacher already knows (`autoKnown: true`, "X qrupa avtomatik qəbul olundu — əvvəl sizin tələbəniz olub", key `group-join:<membershipId>`) |
| `GROUP_JOIN_DECIDED` | the requesting student | IN_APP, PUSH | the teacher approved (links to the group) or declined (neutral wording, links to "Qruplarım") a code request (`docs/GROUP-JOIN.md`); key `group-join-decided:<membershipId>` |
| `SYLLABUS_JOIN_REQUESTED` | syllabus' workspace owner | IN_APP, PUSH | a student sent a group or individual request from the public syllabus page (`syllabus/joinRequests.ts`); once per request, key `syl-join-req:<requestId>` |
| `SYLLABUS_JOIN_DECIDED` | the requesting student | IN_APP, PUSH | the teacher accepted or rejected that request; key `syl-join-decided:<requestId>` |
| `EXAM_RESULT_READY` | student | EMAIL | only for exams with "E-mail results to students" ticked: the 30 s sweeper (`server/modules/resultEmail.ts`) mails each result once it is final (no manual grading pending) and released; score, percentage and the wrong-answer deduction, never the answers. Claimed in `result_email_log` (one row per result; students without an address are logged as `NO_EMAIL` and skipped); key `exam-result:<resultId>` |

### Tasks

Recipients are the active student members of the task's groups plus, for open-link tasks, the
individually picked students (a groups-only task ignores individual picks, as its page does);
never the teacher. An open-link task with nobody selected notifies nobody. On edit only students
the task newly reaches get `TASK_ASSIGNED`. The task form's **Tələbələrə bildiriş göndər**
(default on) turns both notices off for that save.

When a student becomes an active member of a group (join code/link, single-use invite link, e-mail
invite, teacher adds or approves them, or the startup activation of a leftover pending link request),
they get **one** `TASK_ASSIGNED` listing the group's tasks with a future
deadline that they have not submitted and were not told about (key `task-join:<userId>:<hash>`;
each listed task's own key is taken with SKIPPED `BATCHED` rows so it is never announced again).

The notice has the title, a short escaped description excerpt, the deadline in Baku time, the
workspace/teacher name and a link to `/student/assignments?task=<id>` on `APP_PUBLIC_URL`; never
the answer key or files. Large classes: in-app/push go to everyone first, then e-mails, all after
the save returns. E-mails are throttled per process (`EMAIL_MAX_PER_SECOND`, default 8); a Resend
429 halves the rate, pauses for its Retry-After and retries twice before the outbox retry.

Throttling that belongs to the domain stays there: grade e-mails are decided by `grade_email_log`
(only on release or a changed score), AI alerts by `notification_dedupe` (24 h / 6 h per workspace).

### Automatic AI grading

Per task, **AI avtomatik qiymətləndirsin** (`task_grading_settings.autoGrade`, on by default;
migration 0024 copied the old "AI feedback to the student" setting). When the AI review of a
submission finishes, `modules/autoGrade.ts`:

- releases the AI score (0–100, one decimal) and the formatted feedback as the grade
  (`gradedByUserId` null = AI grade; `submission_grading.source = AI`), and sends **one**
  `AI_GRADE_READY` notice (score + summary, strengths, improvements; HTML-escaped, length-capped;
  labelled "AI tərəfindən qiymətləndirilib"). Dedupe key `ai-grade:<submissionId>`; no
  `GRADE_RELEASED` is sent for it.
- leaves the submission to the teacher (`submission_grading.autoStatus = NEEDS_TEACHER`, shown as
  **Müəllim yoxlaması gözləyir**) if: the submission is empty, a deterministic check failed (e.g.
  a file that is not the student's), a file could not be read, prompt injection was suspected, the
  AI failed or was skipped, it gave no feedback, or it asked for the teacher. Late work is graded.
- never overwrites a teacher's grade (the write is conditional on `gradedByUserId IS NULL`).
  A **Yenidən yoxla** rerun may update an AI grade; it sends `GRADE_UPDATED` (key
  `ai-regrade:<submissionId>:<runId>`) only if the score changed, and a failed/doubtful rerun keeps
  the AI grade.

When the teacher edits an AI grade it becomes a teacher grade (`source = TEACHER`) and the student
gets one `GRADE_UPDATED`: via the grade e-mail flow if the score changed, otherwise (feedback only)
with key `grade-override:<submissionId>`. A queued `AI_GRADE_READY` retry is dropped
(`GRADE_CHANGED`) if the grade changed meanwhile. With auto-grade off nothing is sent until the
teacher grades.

## Delivery log (outbox)

`notification_deliveries`: one row per (dedupe key, channel), unique `dedupeKey`, with `status`
`QUEUED → SENDING → SENT | SKIPPED | FAILED`, `attempts`, `nextAttemptAt`, `error` (a short code,
never secrets or addresses), and the event payload.

- `dispatch()` returns immediately; sending runs after the request.
- Transient failures (network, HTTP 429/5xx) retry after 1 min, 5 min, 30 min — at most 4 attempts.
- A worker (every 60 s, started in `server/_core/index.ts`) sends due retries, picks up rows left
  `QUEUED` by a restart, and re-queues rows stuck in `SENDING` for 10 min.
- `SKIPPED` reasons: `OPTED_OUT`, `NO_EMAIL`, `EMAIL_NOT_CONFIGURED`, `PUSH_NOT_CONFIGURED`,
  `NO_DEVICE`, or a send-guard reason such as `GRADE_CHANGED`.
- A dedupe key is used once: a second dispatch with it never sends again.

### Before migrations 0023 / 0024 are applied

All new tables are additive. Without 0023: notices are delivered directly (unlogged and without
retries), preferences read as "all on" and saving them returns an error, device registration
returns an error. The worker logs one warning. Without 0024: auto-grade is off for every task (the
teacher grades as before) and the toggle is disabled with a note.

## Preferences

`notification_preferences (userId, event, channel, enabled)`; no row = on, except channels an event
lists in `defaultOff` (opt-in, e.g. the digest e-mail). Enforced in the
dispatcher. API (tRPC, signed in):

- `inbox.preferences` (query) → `[{ event, channels: [{ channel, enabled }] }]`
- `inbox.setPreference` (mutation) `{ event, channel, enabled }`

Settings → Notifications shows IN_APP, EMAIL and PUSH. One PUSH switch covers the user's browsers
and mobile app alike. Students see the task, grade and announcement rows; teachers see every row.

## Adding an event

1. Add it to `EVENT_TYPES`, `EventData` and `EVENTS` in `events.ts` (channels).
2. Add texts in `templates.ts` and a case in `render.ts`.
3. Call `dispatch({ event, userId, dedupeKey, data })` where it happens. Pick a dedupe key that is
   the same for retries of the same notice and new for a new notice.
4. Add Settings labels `settings.event.<EVENT>` (AZ/EN/RU).

## Browser notification prompt (web)

`client/src/components/NotificationPermissionPrompt.tsx` (mounted once in `App.tsx`), hook
`hooks/useNotificationPrompt.ts`, pure logic in `lib/notificationPrompt.ts` (tests:
`server/notificationPrompt.test.ts`). A non-modal card asks for the browser's notification
permission; after a grant it shows one local test notification ("Resulio.co bildirişləri aktivdir.").

- Shown after 8 s of visible time on site or on the second page (SPA route change), never on
  sign-in/onboarding, exam/task taking, the lesson player or editors with a sticky action bar
  (`EXCLUDED_ROUTES`).
- Only when `Notification` exists, the page is a secure context and the permission is `default`.
  "İndi yox", Escape or × → not again for 7 days; shown and ignored → not again for 1 day;
  granted → never again; a denial is never re-requested (guidance to the browser settings is shown
  only right after the user clicked and the browser answered "denied").
- State: `localStorage["resulio.notifyPrompt.v1"]` = `{ v, shownCount, lastShownAt, dismissedAt,
  grantedAt, deniedAt }`; unreadable storage counts as empty.
- It waits while an element marked `data-notify-avoid` (e.g. the landing hero sign-up buttons) is
  where the card would appear, and re-checks on scroll/resize.

After a grant the browser is also subscribed to web push (next section). The local test
notification is shown in every case, so the prompt works even while web push is off.

## Web push (browsers)

Off until the API service has a VAPID key pair. Generate one and set all three variables on
Railway → **resulio-api** → Variables (not on resulio-frontend):

```bash
node scripts/generate-vapid-keys.mjs mailto:support@resulio.co
# WEB_PUSH_VAPID_PUBLIC_KEY=B...   (65-byte key, base64url)
# WEB_PUSH_VAPID_PRIVATE_KEY=...   (32-byte key, base64url; secret)
# WEB_PUSH_SUBJECT=mailto:support@resulio.co   (or an https:// URL)
```

The server logs `[web-push] Enabled.` or one warning at startup. Missing or malformed keys turn web
push off cleanly: `webPush.config` reports `enabled: false`, nothing is subscribed, and PUSH only
reaches mobile devices. The public key is served at runtime by `webPush.config`, so rotating keys
needs no frontend rebuild (but every browser must re-subscribe, which happens on its next visit).

- **Service worker** `client/public/sw.js`, served as `/sw.js` (root scope, `Cache-Control:
  no-cache`). Push only: no `fetch` handler and no caching, so the SPA, prerendered pages and HTTP
  caching are unaffected. `push` shows the notification (title, body, tag, brand icon/badge, URL);
  `notificationclick` focuses an open Resulio tab (navigating it to the URL) or opens a new one.
  The payload is built by `buildPushPayload` in `server/notifications/webPush.ts`.
- **Client** `client/src/lib/webPush.ts` + `hooks/useWebPushSync.ts`: registers the worker only in a
  secure context with `serviceWorker`, `PushManager` and `Notification`; once permission is
  `granted` it subscribes with the server's public key (re-subscribing if the key changed) and calls
  `webPush.subscribe`. It re-syncs on each visit at most daily, and immediately when the signed-in
  account or the language changes.
- **API** (tRPC, public): `webPush.config` → `{ enabled, publicKey }`; `webPush.subscribe`
  `{ subscription: { endpoint, keys: { p256dh, auth } }, locale }` (20/min); `webPush.unsubscribe`
  `{ endpoint }`. Endpoints must be HTTPS URLs of a known push service (FCM, Mozilla, Apple, WNS) so
  the server can never be made to call other hosts; key sizes are checked.
- **Table** `web_push_subscriptions` (migration 0037): unique `endpointHash` (sha256 of the
  endpoint), endpoint, keys, nullable `userId`, `locale`, `userAgent`, `createdAt`, `lastSeenAt`,
  `failureCount`. The owner follows the session: subscribing while signed in attaches the browser to
  that user, signing out makes it anonymous again on the next sync.
- **Sending**: the PUSH channel (`channels.ts`) sends to the user's Expo tokens and browser
  subscriptions, so every existing PUSH event reaches signed-in users' browsers, respecting their
  preferences. A push service answering 404/410 removes the subscription; 10 failures in a row also
  remove it.
- **Turning it off**: signed-in users untick PUSH per event in Settings → Notifications. Anyone
  (including anonymous visitors) can stop all of them by blocking notifications for resulio.co in
  the browser's site settings; the push service then reports the subscription gone and it is
  deleted on the next send.

Browser support: Chrome, Edge, Firefox and Opera on desktop and Android; Safari 16+ on macOS.
**iPhone/iPad (iOS/iPadOS 16.4+) only supports web push after "Add to Home Screen"** (installed web
app); in a normal Safari tab the API is missing, so the prompt is not shown there. Without
notification permission nothing is subscribed.

## Admin announcements

Admin console → **Announcements** (`/admin/announcements`; permission `announcements.view` to see,
`announcements.send` to send — SUPER_ADMIN only, high-risk, so a sign-in within the last hour is
required). The admin picks an audience (everyone / signed-in / anonymous / teachers = workspace
owners / students = active group members), a language (one of AZ/EN/RU, or "each subscriber's
language" with AZ required and EN/RU optional, falling back to AZ), a title (≤ 80), a short text
(≤ 240) and a link (in-site path or https URL), checks the preview and sends. Every send is audited
(`ANNOUNCEMENT_SENT`).

- Rows in `announcements` keep the texts, audience, status (`QUEUED → SENDING → SENT | FAILED`) and
  counts: target users/anonymous subscribers, in-app sent, push sent/failed. The page refreshes
  while a send is running.
- Sending runs in the background in batches of 500. Signed-in recipients go through the dispatcher
  (event `ANNOUNCEMENT`: in-app feed + their browsers and mobile app, preferences respected, dedupe
  key per user). Anonymous subscribers get web push directly, 10 at a time, each claimed first in
  `announcement_deliveries` (one row per announcement and subscription).
- Idempotent: a restart resumes `QUEUED`/`SENDING` announcements, and neither path sends twice to
  the same user or browser (also when two API instances run it at once).
- Without VAPID keys only signed-in users are reached (in-app feed and mobile push); the page says so.

## Mobile push

Off until configured. Built-in provider: Expo (fits a React Native / Expo app); other providers
implement `PushProvider` in `push.ts`.

Server (Railway, service **resulio-api**):

- `PUSH_PROVIDER=expo`
- `EXPO_ACCESS_TOKEN` — only if "Enhanced push security" is enabled in the Expo project.

App:

1. After sign-in, get the Expo push token (`Notifications.getExpoPushTokenAsync()`), then call the
   tRPC mutation `devices.register` with `{ platform: "ios" | "android", token: "<ExponentPushToken[...]>" }`
   (`provider` defaults to `"expo"`). Easiest with a tRPC client (`@trpc/client` + `superjson`,
   URL `https://<api-host>/api/trpc`). Raw HTTP: `POST /api/trpc/devices.register`, body
   `{ "json": { "platform": "ios", "token": "..." } }` (superjson envelope). Auth is the normal
   session cookie; send `Content-Type: application/json` (required by the CSRF guard). Call it on
   every app start — it is an upsert and refreshes `lastSeenAt`.
2. On sign-out call `devices.unregister` with `{ token: "..." }`.
3. Push data carries `{ event, path }`; open `path` in the app when the notification is tapped.

Tokens are stored in `push_devices` (unique token; a token that signs in as another user moves to
that user). Tokens Expo reports as `DeviceNotRegistered` are revoked automatically. Tokens are
never logged or returned by the API.
