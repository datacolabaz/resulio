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

`notification_preferences (userId, event, channel, enabled)`; no row = on. Enforced in the
dispatcher. API (tRPC, signed in):

- `inbox.preferences` (query) → `[{ event, channels: [{ channel, enabled }] }]`
- `inbox.setPreference` (mutation) `{ event, channel, enabled }`

Settings → Notifications shows IN_APP and EMAIL; PUSH choices belong in the mobile app.

## Adding an event

1. Add it to `EVENT_TYPES`, `EventData` and `EVENTS` in `events.ts` (channels).
2. Add texts in `templates.ts` and a case in `render.ts`.
3. Call `dispatch({ event, userId, dedupeKey, data })` where it happens. Pick a dedupe key that is
   the same for retries of the same notice and new for a new notice.
4. Add Settings labels `settings.event.<EVENT>` (AZ/EN/RU).

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
