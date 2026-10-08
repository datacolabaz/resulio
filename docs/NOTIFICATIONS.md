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
| `TASK_UPDATED` | student | IN_APP, PUSH, EMAIL (e-mail off by default) | an edit moves the deadline by ≥ 1 hour; to students the task already reached; key `task-deadline:<taskId>:<userId>:<deadlineMs>` |
| `GROUP_MEMBER_JOINED` | group's workspace owner | IN_APP, PUSH | a student joined through the group's invite code/link or a single-use invite link (`modules/groupJoin.ts`), or a leftover pending request was activated at startup; informational only, nothing to approve; key `group-join:<membershipId>` / `group-join-link:<linkId>` |
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

Settings → Notifications shows IN_APP and EMAIL; PUSH choices belong in the mobile app. Students
see the task and grade rows; teachers see every row.

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

**No web push yet.** There is no service worker, VAPID key, `PushSubscription` endpoint or web
push provider; `push.ts` only sends to mobile Expo tokens. A grant therefore only enables the local
test notification. To send news/announcements: add a service worker (`push` / `notificationclick`),
a VAPID key pair, a `web` provider in `push.ts` that stores `PushSubscription`s (signed-in users via
`devices.register`; anonymous visitors need a separate subscription table keyed by endpoint), an
`ANNOUNCEMENT` event / admin broadcast, and subscribe right after the grant in `useNotificationPrompt`.

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
