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
| `coach_materials` | 0053 | the student's materials, processing status, OCR summary |
| `coach_topics` | 0053 | topics found in a material (consecutive chunk ranges) |
| `coach_chunks` | 0053 | text passages (pages → chunks), the unit of retrieval and citation |
| `coach_artifacts` | 0054 | generated summaries/concepts per (topic, kind, app language) |
| `coach_quizzes`, `coach_quiz_items` | 0055 | practice quizzes and their questions, answers and grades |
| `coach_topic_mastery` | 0055 | per (student, topic): mastery, evidence of the last 10 quizzes, review schedule |
| `coach_mistakes` | 0055 | wrong answers with a cause, closed when the topic is answered well again |
| `coach_threads`, `coach_messages` | 0056 | tutor conversations per topic (deleted after 90 days) |
| `coach_shares` | 0057 | a material the student shared with one teacher workspace ("Müəllimlə paylaş") |

## Materials

Upload (`/api/files/upload`, context `coach`) or paste text. Files are stored in `files` under the
private workspace id `coach-u<studentId>`: no provider workspace has such an id, so no teacher
reaches them, and `downloadAccess` allows the uploader only. Pasted text is stored the same way as
a `.txt` file so every material has one source file.

Processing runs in-process (`runId`, like the question import; a run older than 15 minutes is shown
as interrupted and can be retried):

1. **Fayl yoxlanılır** (`QUEUED`) — type, size, page count.
2. **Material emal olunur** (`EXTRACTING`, `SEGMENTING`) — text per page (text PDFs, DOCX and TXT
   in virtual pages of ~3000 characters, one page per PPTX slide), then chunks of ~1500 characters
   that respect headings, then topics: the lite model proposes topic starts from an outline;
   `normalizeTopics` keeps a valid ordered cover, and headings are the fallback when the model is
   unavailable or the quota is used up.
3. **Material hazırdır** (`READY`).

`FAILED` shows the reason (`NO_TEXT`, `TOO_MANY_PAGES`, `UNREADABLE`, …) with a retry button.
Deleting a material removes its chunks, topics, generated content and the file (also from R2).

## Learn ("Öyrən")

Per topic (`/student/coach/t/:topicId`), three formats: **Qısa** (summary + key concepts),
**Ətraflı** and **İmtahan üçün** (+ likely questions and common mistakes).

- Context: the topic's chunks (all of them up to 24 000 characters, else the best BM25 matches in
  reading order — `retrieval.ts`). Chunks are labelled `C1…Cn` in the prompt.
- Citations: each point carries quotes; `verifyCites` keeps a quote only if it is really in the
  cited chunk (token match ≥ 85 % after folding case, diacritics and punctuation). A point without
  a verified quote is labelled "general knowledge" in the UI. Quotes are shown verbatim.
- Cache: `coach_artifacts` keyed by (topic, kind, locale); `inputHash` = prompt revision + kind +
  locale + chunk ids and texts. A missing or stale pack is generated once automatically when the
  tab opens (so switching the app language generates that language once); "Yenidən hazırla"
  regenerates. Students can edit a point or definition; an edited pack is kept (flagged) when the
  source text changes, an unedited one is dropped.

## Practice ("Məşq et")

Per topic: the student picks a format (Test, Doğru/Yanlış, Qısa cavab, Uyğunlaşdırma, Hesablama,
Qarışıq) and 5/10/15 questions. One AI call (`COACH_QUIZ`, main model, the app language) writes
the questions from the topic's chunks; `quizgen.ts` converts them to the assessment engine's types
and validates them with the same `questionInputSchema` teachers' questions use. Options are
shuffled on the server; duplicates and broken questions are dropped, and fewer than half of the
asked number fails the request. Earlier questions on the topic are sent as "do not repeat".

- Keys, explanations and sources are not sent before the quiz is submitted. Hints are stored with
  the question (no extra AI call); using one is recorded.
- Grading: closed questions by `gradeQuestion` (the same grader as exams). See "Grading open
  answers" below for written and short answers.
- Mastery: `computeMastery` from the Growth Engine over the coach's own evidence only (origin
  PRACTICE, last 10 quizzes per topic). It never reads or writes teacher results.
- Mistakes: every wrong answer is stored with a deterministic first guess at the cause (numeric
  answer within 10 % → calculation slip; after a hint → not learned; closed question → concept
  confusion). A quiz of ≥ 80 % on the topic closes its older open mistakes.
- XP: `PRACTICE_DONE` once per quiz (`refKey coach:quiz:<id>`, workspace `coach`) — shown only on
  the student's own Growth page.
- Cap: `coach.limits.quizzesPerDay` (event `QUIZ_STARTED`) plus the monthly token and daily action
  quotas.

### Grading open answers

- **Calculations**: the model gives `formula` + `variables` with each answer; `calc.ts` (a small
  arithmetic parser, no `eval`) recomputes it. A key its own formula contradicts is dropped at
  generation; one whose formula cannot be read is kept and labelled "not checked by calculation".
  Tolerance is at least 0.5 % of the value.
- **Short answers**: equal after folding case, diacritics (ə→e, ı→i) and punctuation → correct
  without AI. Close misses (similarity ≥ 0.75, or the accepted answer inside a longer phrase) are
  checked by AI for meaning (`COACH_GRADE`).
- **Written answers (WRITTEN)**: graded by the main model against the rubric and the topic's
  passages, in one call per quiz. Score ≥ 85 → correct, ≤ 15 → wrong, otherwise partly correct;
  feedback (summary, good, missing, rubric points) is in the app language. The student's text is
  fenced with a per-call nonce and treated as data, not instructions.
- **Confidence**: below 0.6 the grade is provisional and is re-graded by the pro model while
  `coach.limits.proGradesPerDay` allows (event `PRO_GRADE`).
- **Dispute** ("Etiraz et"): once per answer, on a first-pass AI grade or a short answer marked
  wrong. The pro model grades independently; its grade is final. Counts against the same cap.
  A pending answer (AI unavailable at submit) shows "Yenidən yoxla" instead.
- Regrades update the quiz score, mistakes and the topic's mastery evidence without counting a new
  practice attempt.

## Review, mistakes and "AI yaddaşı"

- **Schedule** (`review.ts`, pure `nextReview`): after each quiz the topic's next review is set
  from the result — below 50 % → tomorrow; 50–80 % → 2 days, then ×1.2; ≥ 80 % → 3 days, then
  ×2.2; strong mastery ×1.25; at most 60 days. Regrades do not move the schedule.
- **Library**: "Bu gün təkrar et" lists due topics (most overdue, then weakest) with a link to
  practise; "Səhvlərim" (`/student/coach/mistakes`) groups open mistakes by topic with their cause,
  links to re-read or practise, and "Düzəltdim" (event `MISTAKE_FIXED`).
- **Material page**: a mastery badge next to every practised topic.
- **Student home**: a card with due topics and open mistakes, only when the flag is on, the
  notice is accepted and "Xatırlatmalar" is on in coach settings.
- **AI yaddaşı** (coach settings): the topics the coach tracks (mastery, practice count, last
  practice) and the mistakes it remembers, in a `ResponsiveTable`. Each can be deleted, or all at
  once. Forgetting a topic removes its mastery, schedule and mistakes; quiz history and materials
  stay (they are deleted with the material or with "delete all my data").

## Tutor ("Soruş")

Per topic: a free question or a button — **Sadə izah et**, **Nümunə göstər**, **Məni yoxla**.

- Context: the topic's best passages for the question (BM25, up to 12 000 characters; the whole
  material when the topic has none), the last 8 messages of the conversation, and the app
  language. The student's text is fenced with a per-call nonce and treated as data.
- **Hint first**: a message that looks like an exercise (solve/calculate verbs in AZ/EN/RU, or
  arithmetic with `=`/`?`) gets one hint, not the answer; asking again right after a hint gets the
  full solution (`tutorMode`).
- **Grounding label**: "Materialınızdan" only when quotes check out (`verifyCites`); otherwise
  "Material + ümumi bilik", "Materialda yoxdur: ümumi bilik" or "Mövzudan kənar"
  (`finalGrounding`). Quotes are shown verbatim with page chips.
- **Recall** (coach setting): NORMAL adds a one-line re-check of an open mistake on the topic every
  4th reply, LOW at most once a day, OFF never (event `RECALL_SHOWN`).
- **Exam lock**: while the student has an exam attempt `IN_PROGRESS` before its deadline, the
  tutor, new summaries and new quizzes return `COACH_LOCKED_DURING_EXAM` (read-only query on
  `attempts`, using `attempts_status_deadline_idx`). The tab shows a lock notice.
- Caps: `coach.limits.tutorPerDay` (event `TUTOR_ASKED`), 10 messages/minute, plus the token and
  daily action quotas. Conversations can be deleted by the student.

## OCR (scanned PDFs and images)

PDF pages with fewer than 30 letters/digits in their text layer, and images, are read by the OCR
model (`coach.models.ocr` → `COACH_OCR_MODEL` → main) in batches of 5 pages (`pdfPick` builds a
small PDF of just those pages). The model transcribes verbatim in the page's own language.

- Caps: `coach.limits.ocrPagesPerMaterial` (30) and `coach.limits.ocrPagesPerMonth` (200), counted
  from `coach_events` type `OCR` (`meta.pages`), so deleting a material does not refund pages.
  Pages over the cap are skipped; the material is still built from the other pages and shows a
  notice (`errorCode = OCR_LIMIT` on a `READY` material). With nothing readable it fails with
  `OCR_LIMIT`.
- MVP: printed text only. The upload form and the text page say that handwriting, complex
  formulas, tables and multi-column pages may be recognised incorrectly.
- Quality per page, deterministic (`pageQuality`): 50 % the model's confidence, 25 % text density
  (letters/digits vs a full page of ~350), 25 % cleanliness (garbage characters and `[?]` markers;
  20 % garbage scores zero). Below 60 the page is low quality; the material's worst page decides
  `needsReview`.
- Low quality: the material shows "Mətni tam tanımaq mümkün olmadı. Daha aydın fayl yükləyin və
  ya tanınmış mətni yoxlayın." with a link to the text page (`/student/coach/m/:id/text`), where
  every chunk can be corrected. A correction updates the chunk, bumps `textRevision` and drops the
  generated content of that topic; "Mətni yoxladım" clears the warning.
- Providers that cannot read PDFs (`COACH_PDF_MODE=text`, or a non-Gemini/OpenAI endpoint) skip
  OCR of PDF pages; images still go through OCR.

## Sharing with a teacher ("Müəllimlə paylaş")

Off by default; personal materials are visible only to the student. On a `READY` material the
student picks a teacher from the workspaces of their **active** groups (`activeGroupIdsOfStudent`;
one entry per teacher workspace) and shares. One row per (material, teacher); the student can
revoke at any time, and deleting the material deletes its shares.

- The teacher sees, read-only, under `/teacher/coach-shares` (nav item shown only when something is
  shared): the file (download is allowed through `downloadAccess` only while a share exists), the
  topic list and summaries the student already generated — preferring the teacher's language,
  otherwise any language. No generation happens on the teacher's side, and quizzes, answers,
  mastery, mistakes, tutor conversations and AI memory are never shown.
- Shares are tied to the workspace that was chosen; if the student leaves the group the share stays
  until revoked and is labelled as a former teacher on the student side.
- Coach code never writes teacher tables; `coach_shares` is a side table read by
  `teacher.coachShares.list/get` scoped to `ctx.workspace`.

## Retention and "delete all my data"

A job in the API process checks hourly and runs once per Baku day (skipped while migrations are
behind):

| What | Deleted after |
| --- | --- |
| tutor messages (and conversations left empty) | 90 days |
| `FAILED` materials | 7 days |
| materials not opened (or created, if never opened) | 365 days |
| `coach_events` | 400 days |

Materials are removed through the same path as a manual delete (file, topics, chunks, artifacts,
quizzes, mastery, mistakes, conversations, shares).

"Bütün məlumatlarımı sil" in the coach settings (`coach.deleteAllData`, needs `{confirm: true}`)
removes every coach row and file of the student, including AI memory, shares and settings (the
privacy notice is shown again). Cap events of the current month (`OCR`, `UPLOAD`, `QUIZ_STARTED`,
`TUTOR_ASKED`, `PRO_GRADE`) are kept with their references cleared so quotas cannot be reset by
deleting data. `ai_request_logs` rows (token accounting) are not touched.

## Admin settings

`/admin/settings` → "AI Study Coach": monthly token quota, daily AI actions, every `coach.limits.*`
cap and the model per role (`coach.models`). Saved via `admin.ai.setCoachSettings` (permission
`ai.manage`) into `platform_settings`; empty = default, `0` = unlimited; cached for 30 seconds.
Who can use the coach is the `study_coach` feature flag (off by default; pilot through
`STUDY_COACH_ENABLED_USERS` / `STUDY_COACH_ENABLED_WORKSPACES`, then enable for all students).

All migrations use `CREATE TABLE IF NOT EXISTS`; every identifier (tables, columns, indexes,
generated primary-key names) is at most 64 characters — `pnpm db:verify` and
`server/migrationIdentifiers.test.ts` fail otherwise.

## Errors

`COACH_NOT_AVAILABLE` (flag off), `COACH_DB_NOT_READY` (migration not applied yet),
`COACH_CONSENT_REQUIRED`, `COACH_MONTHLY_LIMIT`, `COACH_DAILY_LIMIT`, `COACH_FEATURE_LIMIT`,
`COACH_AI_BUSY` (provider rate limit), `AI_INVALID_OUTPUT`, `AI_UNAVAILABLE`.
