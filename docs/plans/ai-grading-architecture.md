# Task submission, file grading & AI cost architecture

Status: **plan only — not implemented.** Nothing below exists yet unless marked "exists". No schema,
code or migration has been written for this. Saved here per Telman's request, as reference for when
this work actually starts.

Core idea: don't make AI the default grading engine for every submitted file. Structure the
submission first, check the objective part with code, and only call AI where a rubric, an
explanation, or an open-ended answer genuinely needs it. A teacher posts a task, a student submits
a file, the system checks as much as it can on its own, and AI spends credits only where it's
actually earning its keep. This is also the pricing model: the core product (groups, tasks, exams,
sharing, basic results) stays free with no plan wall — a balance of **AI credits** is spent only
when AI is actually invoked (question generation, rubric grading, explanations, deep analysis).

---

## 1. Audit of what exists today

| Area | Current state | Consequence for this plan |
| --- | --- | --- |
| Task submission | `taskSubmissions` (`server/modules/tasks.ts`, `submitAssignment`): student submits a list of already-uploaded `{fileId, name, size}` references; status is mechanically `SUBMITTED`/`LATE` only, set by comparing to the deadline. | This is the row the new `SubmissionValidationResult`/`AIGradingResult` pipeline below would hang off of. No parsing or validation of file contents happens anywhere today. |
| Grading | None. A teacher reviews submissions manually via Results/"Nəticələr". `activity.ts` tracks *viewed/not-viewed*, not correctness. | Everything in this plan — rule engine, spreadsheet validation, AI rubric grading — is new. |
| Existing AI feature | `server/modules/ai.ts` + `server/_core/llm.ts`: **question generation only** — teacher gives a topic, AI drafts MCQ/true-false/short-answer/etc. questions for the exam builder. Calls an internal "Forge" LLM proxy (`MANUS_API_URL`/`MANUS_API_KEY`), one JSON-mode call per request. | The model-invocation plumbing (`invokeLLM`) already exists and can likely be reused for rubric grading and spreadsheet-error explanation — but it has no cost/credit accounting today. |
| "Usage limit" today | `resulioStore.ts`: **in-memory**, per-workspace flat counter (`{used, limit: 100}`), reset on every server restart/deploy. Not a credit ledger — no reservation, no refund, no per-operation cost, no purchase flow. | The credit economy below (reserve → charge/refund, ledger table, purchase flow) replaces this with something persistent and accurate; the old counter can retire once it does. |
| File storage | `server/storage.ts` — signed-URL based `storagePut`/`storageGetSignedUrl`, already used for submission files and materials. | Spreadsheet/CSV parsing reads from here; no new storage layer needed, just a parser step. |
| Billing / payments | None. `provider_workspaces.subscriptionStatus` defaults to `BETA` and nothing enforces it. No payment provider is integrated. | The credit *purchase* flow (`[10 kredit al]` etc.) needs a payment provider decision before it can ship — out of scope for this doc, called out explicitly below. |

---

## 2. Grading tiers

| Task type | How it's checked | AI credit |
| --- | --- | --- |
| Quiz, multiple choice, true/false, numeric answer | Fully automatic, rule-based | 0 |
| Excel/CSV — specific cell, formula, column, format, table rule | Parser + validator + teacher-defined rules | 0, or very little |
| TXT / essay / open-ended / explained solution | AI grading against a rubric, with feedback | Credits |
| Mixed task | Objective part by code, explained part by AI | Only the AI part |
| Very complex or flagged answer | AI first pass + teacher review | More credits |

Rationale: running AI on an Excel file just to check a column exists, compare two numbers, or verify
a simple formula is pure waste — a parser + rule engine is cheaper, more stable, and its verdict can
actually be explained to the student ("row 7's formula is missing", not "the AI thinks this is
wrong"). AI earns its cost on open-ended answers, but only when it's given a rubric, a reference
answer, and a scoring scheme — not asked to "grade it however it sees fit". This also matches how
education-tooling guidance generally frames it: automated grading is most reliable on objective,
bounded answers, and most variable on free-form writing without a rubric and some human oversight.
(See CMU's notes on generative AI for grading and feedback:
https://www.cmu.edu/teaching/technology/aitools/gen-ai-for-grading-and-feedback/index.html)

## 3. Teacher-facing flow

When creating a task, the teacher picks one of three modes:

- **Avtomatik yoxlanacaq** — quiz, numeric, Excel/CSV rules, true/false.
- **AI ilə rəy veriləcək** — written answer, essay, explained solution, text analysis.
- **Qarışıq** — the system checks the objective part, AI reviews the explained part.

### Excel / CSV task

The teacher uploads the file/template and defines rules in plain language, e.g.:

> - "Ad soyad" sütunu doldurulmalıdır
> - "Cəmi" sütununda formula olmalıdır
> - "Orta bal" düzgün hesablanmalıdır
> - B2:B20 hüceyrələri rəqəm olmalıdır
> - Cədvəldə 20 sətir olmalıdır
> - Son nəticə 85 ilə 100 arasında olmalıdır

On submission: validate file type/size → security/virus scan → parse into structured data → check
sheet/column/cell/formula/value/format rules → return a result immediately, with specific errors
(not just a score):

> Nəticə: 72/100
>
> Düzgün: ✓ Ad soyad sütunu doldurulub · ✓ 20 sətr məlumat daxil edilib · ✓ Cəmi sütunundakı
> formullar düzgündür
>
> Düzəldilməlidir: ✕ "Orta bal" sütununda 7-ci və 12-ci sətirdə formula yoxdur · ✕ B2:B20
> aralığında 2 mətn dəyəri tapıldı · ✕ Hesablanmış yekun nəticə 83.5-dir, gözlənilən nəticə 87-dir

No AI call for this — zero cost. An optional button, **[AI ilə izah et — 1 kredit]**, lets the
student ask AI to explain *why* a specific rule failed in plain language, using only the validation
errors + task instructions + minimal relevant cell/column context — never the whole workbook unless
the teacher explicitly opts into that (and sees the credit estimate first).

### Text / written-answer task

The teacher sets: prompt, max score, a weighted rubric, an optional reference answer, whether AI
grading is on, whether the student sees AI feedback immediately or only after teacher approval, and
a maximum AI credit spend per submission.

> Rubrika: Mövzunun düzgün izahı 0–8 · Ən azı iki nümunə 0–6 · Məntiq və struktur 0–4 · Dil və yazı
> keyfiyyəti 0–2

Pipeline: validate (length, blank, obvious duplication/relevance) → cheap pre-classification → build
a structured prompt from the *stable* rubric + the student's answer → require strict JSON output →
validate against a schema → store a confidence score → route low-confidence or flagged answers to
teacher review → show the student only teacher-approved feedback if approval mode is on.

Required AI JSON shape:

```json
{
  "totalScore": 14,
  "maxScore": 20,
  "criteria": [{ "criterionId": "topic_accuracy", "score": 6, "maxScore": 8, "evidence": "..." }],
  "strengths": ["..."],
  "improvements": ["..."],
  "nextStep": "...",
  "confidence": 0.0,
  "needsTeacherReview": false
}
```

Guardrails: AI grading is preliminary by default and the teacher can override any score or
criterion, with the override reason stored in an audit log; AI must not invent claims the task
material doesn't support; the student never sees the system prompt, the provider/model name, or raw
reasoning; AI must never assert "plagiarism" as a fact — only a similarity/risk flag routed to
teacher review; the teacher can turn AI scoring off entirely and keep feedback-only mode.

## 4. Keeping AI cheap

The rule to avoid: one student submission → one full, expensive AI call that resends the whole
rubric and task text every time. For a class of 30, that's the rubric re-sent 30 times.

- Store the rubric once, as structured data — never re-send free text for it per student.
- Split the reference answer into only the parts actually needed, not the whole thing.
- Use a stable prompt prefix per teacher/task so provider prompt caching can apply.
- Classify first with a cheap model/pass; only route long, ambiguous, or low-confidence answers to
  a stronger model.
- Keep AI output short and structured — never a free-form "teacher-style essay" response.
- Hash submissions/files: an unchanged resubmission or duplicate upload reuses the prior result
  instead of re-running AI.
- Default to short feedback; only generate a deep review when the teacher explicitly asks for it.
- Batch non-urgent class-wide grading through an async queue instead of grading synchronously.

Two concrete provider mechanisms this plan should use once implementation starts: prompt caching
(cached-context reads are substantially cheaper than fresh input on most providers — see OpenAI's
notes: https://developers.openai.com/cookbook/examples/prompt_caching_201) and batch/async
processing (Anthropic's Batch API, for example, discounts batched input/output ~50%) for grading
jobs that don't need an instant response.

### Model routing

1. **Rule engine** — quiz/numeric/exact answers, Excel/CSV/formula/format validation. 0 AI credits.
2. **Cheap classifier** — language, length, blank/duplicate detection, task relevance, risk routing. Very low cost.
3. **Standard grading model** — short/normal text answers, rubric score + concise feedback. Medium cost.
4. **Premium reasoning model** — long essays, complex technical answers, teacher-requested deep
   review, or a low-confidence/conflicting result from the standard model. High cost.

Which tier ran is never shown to the user — only the credit estimate is:

> Bu yoxlama təxminən 2 kredit istifadə edəcək. **[AI ilə yoxla — 2 kredit]**

For variable-cost jobs, show a range and a hard cap before running, never charge silently:

> Bu iş uzun mətn və rubrika analizi tələb edir. Təxmini xərc: 6–8 kredit. **[8 kreditlə yoxla]**

## 5. "Simple + Pro" without a plan wall

No visible "Basic / Pro" plan picker, no forced plan choice at onboarding. The product stays framed
as free; a credit balance is the only thing that changes.

| What the user sees | What's actually true underneath |
| --- | --- |
| Resulio is free | Core workflow (groups, tasks, exams, sharing links, basic results) stays free, no plan wall |
| Creating tasks/exams is free | Builds the user base and habit |
| Group/link/Telegram/WhatsApp/QR sharing is free | Growth stays unconstrained |
| Rule-based Excel/CSV checking is free | No AI cost on the objective path |
| Core results/analytics is free | Keeps the teacher on the platform |
| AI question generation costs credits | Token cost is monetized |
| AI rubric grading / open-ended feedback costs credits | Expensive inference is monetized |
| Deep analytics / individualized study plans cost credits | Premium value is monetized |

Balance/profile copy:

> AI kreditləri — Balans: 38 kredit
> **[10 kredit al] [50 kredit al] [200 kredit al]**
> Kreditlər yalnız AI əməliyyatlarında istifadə olunur. Qrup, task, imtahan, paylaşım və əsas
> nəticələr pulsuzdur.

New users can get a small, one-time, non-withdrawable welcome credit grant — enough for a few cheap
operations (a handful of short questions, one short-answer review), never enough to run unlimited
essay grading for free, and with duplicate-account abuse prevention.

**Open question, not covered by this plan**: a credit *purchase* flow needs a payment provider
(Stripe or similar) wired up — nothing in the current codebase handles payments at all (see the
audit table above). That integration decision has to happen before "`[10 kredit al]`" can be a real
button.

## 6. Not 1:1 with provider tokens — price the result, not the token

A credit's price should never equal a raw token price passed straight through; the platform is
selling a *result*, and the price needs to cover more than the model call itself:

```
provider input cost
+ provider output cost
+ caching/batch cost
+ storage and queue cost
+ payment processing cost
+ retry/error allowance
+ fraud/support allowance
+ target gross margin
= internal full cost of one operation
```

credit price = internal full cost × safety factor × target margin

Safety rules this implies: cap max tokens per operation; compute the max possible cost *before*
reserving any credit; refund in full on a failed job, and don't charge full price for a partial
result; require explicit user confirmation above a configured credit threshold (e.g. "up to 8
credits"); never let a balance go negative; and track `estimated_cost`, `actual_cost`,
`credits_reserved`, `credits_charged`, `credits_refunded` per AI job so the numbers are always
auditable (a user should never have to ask "why did my balance drop?").

Credit lifecycle: **reserve** the estimated maximum before the job starts → **charge** the actual
configured amount only on success → **refund** the full reservation on failure → charge nothing (or
partially, if a validated partial result was actually delivered) on partial failure.

---

## 7. Reference: drop-in spec block for an implementation agent

The block below is written as a self-contained instruction set (English, imperative) meant to be
pasted into an agent prompt (Claude Code / Cursor / similar) once this work is actually picked up.
It restates everything above as concrete build requirements, plus a data model sketch and a QA
checklist. Kept verbatim here so it doesn't need to be re-derived later.

```text
TASK SUBMISSION, FILE GRADING AND AI COST ARCHITECTURE

Product goal:
Teacher creates a task.
Task can be Excel, CSV, TXT, or a structured answer.
Student submits the task.
The system automatically grades whatever it can without AI.
AI is called only when open-ended answers, explanations, rubrics, feedback, or complex analysis are
actually needed.
Goal: high-quality feedback while keeping AI cost to a minimum.

Core principle:
Do not use AI as the default grading engine.
Use a deterministic rule engine, parser, and validator first.
AI runs only where it creates real value.

TASK TYPES

Let the teacher choose a task type at creation time:

1. Quiz / objective task
   - Multiple choice, true/false, numeric answer, short exact answer
   - Rule-based scoring
   - No AI credit used

2. Spreadsheet task
   - Excel .xlsx, CSV, structured table task
   - Column, row, cell, formula, and format validation
   - No AI credit used by default

3. Text task
   - TXT, open-ended answer, essay, written explanation
   - AI rubric grading optional, AI feedback optional
   - Uses AI credit

4. Mixed task
   - Spreadsheet/objective rules + text explanation
   - Objective part validated by rule engine
   - Open explanation part graded by AI
   - Credit charged only for the AI part

SPREADSHEET / CSV VALIDATION

Excel and CSV tasks must be gradable without AI.

Teacher rule builder supports:
   - Required sheet name, required columns, required/minimum rows
   - Required cell values, numeric range, date validation
   - Formula presence validation, formula result validation
   - Formatting validation where feasible
   - Duplicate detection, missing-value detection
   - Allowed file size/type, required template version
   - Optional reference file / expected output file

Student submit flow:
   1. Upload the file
   2. Validate file type, size, and run a security scan
   3. Parse the file into canonical structured data
   4. Run the rule engine against the task's rules
   5. Return the result immediately
   6. Show the student specific errors, not just a score
   7. Allow retry if the teacher enabled it

Spreadsheet security:
   - File type allowlist, file size limits, malware scan integration point
   - Separate risk handling for macro-enabled files
   - Guard against formula injection and CSV injection
   - Never expose a raw upload via a public URL directly — use private storage + signed temporary
     download URLs
   - Store the submitted file immutably
   - If the same file hash is re-uploaded, reuse the prior deterministic validation result

AI EXPLANATION FOR SPREADSHEET

After validation, show an optional action:
   [Explain errors with AI — {estimated_credits} credits]

AI must receive only: the validation errors, the teacher's task instructions, relevant
cell/column metadata, and (if needed) a minimal anonymized file excerpt.
Never send the entire workbook by default. Full-workbook analysis only if the teacher explicitly
opts in and confirms the credit estimate.

TEXT / ESSAY / OPEN-ENDED GRADING

Teacher-configurable per task: prompt, max score, rubric criteria with weights, optional reference
answer, feedback language, AI grading on/off, teacher-approval-required on/off, whether the student
sees AI feedback immediately or only after approval, retry policy, max submission length, max AI
credit spend per submission.

AI grading pipeline:
   1. Validate length, blank answer, language, and task relevance
   2. Run a cheap classification/quality pre-check
   3. Build a structured grading prompt from the stable rubric + student answer
   4. Require strict JSON output from the model, no free text
   5. Validate the JSON against a schema
   6. Compute score and feedback
   7. Store a confidence score and a reasoning summary
   8. Route low-confidence, rubric-conflicting, or suspicious answers to teacher review
   9. Show the student only teacher-approved feedback if approval mode is enabled

Required AI JSON response shape:
{
  "totalScore": 14,
  "maxScore": 20,
  "criteria": [
    { "criterionId": "topic_accuracy", "score": 6, "maxScore": 8, "evidence": "..." }
  ],
  "strengths": ["..."],
  "improvements": ["..."],
  "nextStep": "...",
  "confidence": 0.0,
  "needsTeacherReview": false
}

AI grading guardrails:
   - AI grading result is preliminary by default
   - Teacher can override score, per-criterion score, and feedback; override reason is audit-logged
   - AI must not invent claims beyond the task material
   - Feedback must be short, constructive, and age-appropriate
   - Student must never see the hidden system prompt, provider/model name, raw reasoning, or
     private teacher notes
   - AI must not assert "plagiarism" as a final fact; use similarity/risk-flag wording and route to
     teacher review
   - Low-confidence grading must be labeled for teacher review
   - Teacher can disable AI scoring entirely and use feedback-only mode

AI COST OPTIMIZATION

Do not call a premium model for every submission. Implement model routing:

Layer 1 — Deterministic rule engine
   Quiz answers, numeric answers, exact answers, Excel/CSV validation, formula validation, file
   structure validation. Cost: 0 AI credits.

Layer 2 — Cheap classifier
   Empty/invalid submission detection, language detection, length classification, basic task
   relevance, duplicate/retry detection, risk routing. Cost: very low.

Layer 3 — Standard grading model
   Short and normal text answers, rubric-based score, concise feedback. Cost: medium.

Layer 4 — Premium reasoning model
   Long essay, complex technical answer, deep rubric analysis, teacher explicitly selects "deep
   review", or a low-confidence/conflicting standard-model result. Cost: high.

Prompt and context optimization:
   - Store the teacher's rubric as structured data, not repeated free text
   - Use a stable prompt prefix per teacher/task to benefit from provider prompt caching
   - Never send full task history, full class history, or a full workbook by default — only the
     necessary rubric, instructions, reference excerpt, and student response
   - Truncate safely per configured limits; for long documents, chunk and retrieve only relevant
     segments
   - Keep AI feedback concise by default; use strict structured JSON output
   - Reuse validation/AI results when the same file hash or answer hash reappears
   - On resubmission, reprocess only the changed sections where technically possible
   - Batch asynchronous, non-urgent grading jobs; only grade synchronously when actually required
   - Never blindly retry an expensive AI request — use idempotency keys and a bounded retry policy

CREDIT ECONOMY

User-facing language: never show raw provider tokens to normal users — use "AI credits".

Stays free, no credit cost:
   account creation, group creation, task creation, exam creation, link/Telegram/WhatsApp/QR
   sharing, student joining, basic analytics, objective quiz grading, rule-based spreadsheet/CSV
   validation.

Costs AI credits:
   AI question generation, AI rubric creation, AI spreadsheet error explanation, AI text/essay
   grading, AI open-ended feedback, AI misconception analysis, AI individualized study
   suggestions, deep analytics, teacher-selected deep review.

Pricing UX: show a clear estimate before every AI operation, e.g.
   [Generate 10 questions with AI — ~2 credits]
   [Explain errors with AI — 1 credit]
   [Grade this written work with AI — ~3 credits]
   [Get a deep review with AI — ~8 credits]

For variable-cost operations, show a range and a hard cap, and require confirmation:
   "This task is long and detailed. Estimated cost: 6-8 credits. Maximum charge: 8 credits."
   [Grade for up to 8 credits]  [Cancel]

Never charge credits silently.

Credit reservation:
   - Reserve the estimated maximum before an AI job starts
   - Do not permanently deduct credits before successful completion
   - On success, charge the actual configured amount
   - On failure, refund the full reservation
   - On partial failure, charge only if useful validated output was delivered, otherwise refund
   - Maintain a credit transaction ledger; prevent a negative balance
   - If balance is insufficient, show the required credits and a purchase action
   - Never block core, non-AI product usage due to a zero AI credit balance

Required credit ledger fields: id, userId, jobId, operationType, estimatedCredits,
reservedCredits, chargedCredits, refundedCredits, status, providerCostEstimate,
actualProviderCost, createdAt, completedAt.

INTERNAL UNIT ECONOMICS

Do not price credits as raw API tokens — credits represent user value, not provider token count.

For each AI operation, calculate internally:
   provider input cost + provider output cost + caching/batch cost + storage and queue cost +
   payment processing cost + retry/error allowance + fraud/support allowance + target gross
   margin = internal full operation cost

Product pricing requirements:
   - Configure a max token/input/output limit per operation
   - Configure a max provider cost per operation
   - Configure a credit price per operation and a target gross margin
   - Admin can change these values without a redeploy
   - No operation starts if predicted cost exceeds the allowed max
   - If a task is too expensive, require teacher confirmation before processing
   - Use an async queue for large class-wide batches; use batch provider mode where it's cheaper
     and an instant response isn't required
   - Show job status to the teacher: Waiting / Checking / Ready / Needs teacher review /
     Failed — credits returned

SIMPLE + PRO PRODUCT MODEL

Do not show a conventional monthly subscription plan picker as the primary experience. Do not
force a plan choice at login or onboarding.

Visible message: "Use Resulio for free. Spend AI credits only for what you actually use — AI
question generation, grading written work, and deep analysis."

Simple: free core workflow (groups, tasks, exams, student sharing, basic analytics, rule-based
grading), with a small limited welcome AI credit grant.

Pro: not a separate subscription wall — AI-powered capabilities unlocked through prepaid credits.

Credit wallet UI: "AI credits — Balance: {credit_balance} credits" with
[Buy 10 credits] [Buy 50 credits] [Buy 200 credits], and the note that credits are spent only on
AI operations — groups, tasks, exams, sharing, and core results stay free.

WELCOME CREDIT RULES

New users may receive a small one-time welcome credit grant. It must be: limited,
non-withdrawable, expirable if necessary, never enough to unlock unlimited expensive essay
grading, usable only for low-cost demonstrations (a short question-generation run, one short-answer
review, one spreadsheet explanation), and protected against duplicate-account abuse.

TASK SUBMISSION DATA MODEL

Add or ensure these entities exist: Task, TaskVersion, TaskSubmission, SubmissionFile,
SubmissionContent, SubmissionValidationResult, SpreadsheetRule, SpreadsheetValidationResult,
Rubric, RubricCriterion, AIGradingJob, AIGradingResult, TeacherReview, CreditReservation,
CreditLedgerEntry, ProviderUsageRecord.

TaskSubmission status flow: draft -> submitted -> validating -> rule_checked -> ai_queued ->
ai_checking -> needs_teacher_review -> graded -> returned -> failed.

REQUIRED QA

   - Teacher creates an Excel task with spreadsheet validation rules
   - Student uploads a valid XLSX file
   - Student uploads an invalid XLSX file and sees cell/column-specific errors
   - CSV file validation works
   - TXT task with a rubric is graded through strict JSON output
   - Objective task uses no AI credit
   - Spreadsheet rule validation uses no AI credit
   - AI spreadsheet explanation consumes the estimated credit only after a successful output
   - Text grading reserves credits, charges on success, refunds on failure
   - Same file hash does not trigger a duplicate expensive AI job
   - Low-confidence essay grading is routed to teacher review
   - Teacher can override the AI score and feedback
   - Student sees only approved feedback when approval mode is active
   - A long document requires explicit confirmation of a maximum credit charge
   - A zero credit balance never blocks non-AI task/exam usage
```
