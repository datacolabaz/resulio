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
| `AI_FEEDBACK_READY` | student | EMAIL, PUSH | AI pre-review finished (`modules/aiFeedbackNotify.ts`) |
| `GRADE_RELEASED` | student | IN_APP, EMAIL, PUSH | teacher releases a grade (`modules/tasks.ts`, `modules/gradeEmail.ts`) |
| `GRADE_UPDATED` | student | EMAIL, PUSH | released score changes |
| `AI_LIMIT_80` | workspace owner | IN_APP, PUSH | 80% of the daily AI cap (`modules/aiAlerts.ts`) |
| `AI_LIMIT_REACHED` | workspace owner | IN_APP, PUSH | daily AI cap reached |
| `AI_PROVIDER_ERROR` | workspace owner | IN_APP, PUSH | AI provider answered 401/403 (key) or 429 (quota) |

Throttling that belongs to the domain stays there: grade e-mails are decided by `grade_email_log`
(only on release or a changed score), AI alerts by `notification_dedupe` (24 h / 6 h per workspace).

### AI feedback to the student

Sent when the review is `DONE` and none of these hold: prompt injection was flagged
(`INJECTION_SUSPECTED`), no feedback text, the submission is already graded or released, the
teacher turned off **AI rəyini tələbəyə avtomatik göndər** for the task (`task_notification_settings`,
on by default). The same checks run again right before each send/retry. The e-mail contains the
summary, strengths and improvements (control characters stripped, length-capped, HTML-escaped),
says it is preliminary and that the teacher gives the final grade, and never contains the
suggested score or teacher notes. Dedupe key `ai-feedback:<submissionId>`: a rerun re-sends only
if the earlier delivery was skipped or failed (e.g. e-mail was not configured yet).

## Delivery log (outbox)

`notification_deliveries`: one row per (dedupe key, channel), unique `dedupeKey`, with `status`
`QUEUED → SENDING → SENT | SKIPPED | FAILED`, `attempts`, `nextAttemptAt`, `error` (a short code,
never secrets or addresses), and the event payload.

- `dispatch()` returns immediately; sending runs after the request.
- Transient failures (network, HTTP 429/5xx) retry after 1 min, 5 min, 30 min — at most 4 attempts.
- A worker (every 60 s, started in `server/_core/index.ts`) sends due retries, picks up rows left
  `QUEUED` by a restart, and re-queues rows stuck in `SENDING` for 10 min.
- `SKIPPED` reasons: `OPTED_OUT`, `NO_EMAIL`, `EMAIL_NOT_CONFIGURED`, `PUSH_NOT_CONFIGURED`,
  `NO_DEVICE`, or a send-guard reason such as `ALREADY_GRADED`.

### Before migration 0023 is applied

All new tables are additive. Without them: grade and AI-alert notices are delivered directly (as
before, just unlogged and without retries), AI-feedback e-mails are not sent, preferences read as
"all on" and saving them returns an error, device registration returns an error. The worker logs
one warning.

## Preferences

`notification_preferences (userId, event, channel, enabled)`; no row = on. Enforced in the
dispatcher. API (tRPC, signed in):

- `inbox.preferences` (query) → `[{ event, channels: [{ channel, enabled }] }]`
- `inbox.setPreference` (mutation) `{ event, channel, enabled }`

Settings → Notifications shows IN_APP and EMAIL; PUSH choices belong in the mobile app.

## Adding an event

1. Add it to `EVENT_TYPES`, `EventData` and `EVENTS` in `events.ts` (channels, fallback, resend rule).
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
