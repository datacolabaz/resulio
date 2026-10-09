# AI usage, cost and teacher limits

## What is logged

Every model request made through `invokeLLM` (question generation, question and syllabus import,
submission review, answer-key drafts) gets one `ai_request_logs` row: teacher, workspace, feature,
model, prompt / completion / total tokens, estimated cost, status (`OK`, `ERROR`, `RATE_LIMITED`),
HTTP status, latency and time. Tokens come from the provider's `usage`; when a reply has none they
are estimated (≈4 characters per token, a flat amount per image or file) and flagged.

Logging is a listener in `server/_core/llm.ts` that reads the caller's context (`withAiUsage`, an
AsyncLocalStorage that follows background import jobs) and writes the row in the background. A
failed or slow write never fails or delays the AI call.

## Cost and budget

Cost = prompt tokens × input price + output tokens × output price, with prices per million tokens
from `ai_model_prices` (Admin → AI usage → Pricing). Output includes Gemini's thinking tokens, which
the OpenAI-compatible API counts in `total_tokens` only. A model without its own row uses the `*`
row. The seeded Gemini prices are estimates; check them against Google's pricing page. The cost is
fixed when the request is logged, so a price change only affects new requests.

Gemini has no API for the remaining balance, so the admin sees **this month's estimated spend** against
an optional monthly budget (a progress bar and an end-of-month projection), not a balance. The real bill
is in Google Cloud Billing. API keys stay in Railway variables (`AI_API_KEY`); nothing secret is
stored in the database.

## Teacher limits

Admin → Teachers → AI limits. Two limits, each with a global default and a per-teacher override:

| | Counts | Period |
| --- | --- | --- |
| Monthly token quota | total tokens (input + output) | calendar month, Baku time |
| Daily AI action cap | user actions (one import, one review, one generation — however many model requests each needs) | day, from Baku midnight |

- Global default: empty or `0` = unlimited (the initial state).
- Teacher override: empty = use the global default, `0` = unlimited for that teacher, `> 0` = that limit.
- "Reset usage" starts the teacher's count again from now for the current day and month (log rows are kept).

Limits are checked on the server when a teacher starts an AI action; an action already running is not
cut off, so a teacher can go somewhat over the quota with their last action. Over the limit, starting
fails with "limit reached, resets on <date>", and automatic submission reviews for that teacher's
tasks are skipped with a note. Teachers see their usage (and a warning from 80%) in the import screens.
Counts are computed from the log rows (no separate counters), and if the limit tables cannot be read
the check lets the call through.

These limits are on top of the existing per-workspace daily caps (`AI_REVIEW_DAILY_LIMIT`,
`SYLLABUS_IMPORT_DAILY_LIMIT`, question-import cap).

## Permissions

`ai.view` (analytics, log, prices, limits; super and support admins) and `ai.manage` (prices, budget,
limits, resets; super admins). Every change is written to the audit log.
