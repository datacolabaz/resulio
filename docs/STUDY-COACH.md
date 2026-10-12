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
- Grading: closed questions by `gradeQuestion` (the same grader as exams). Open written answers
  (WRITTEN) are graded by AI in the grading phase; until then they stay pending.
- Mastery: `computeMastery` from the Growth Engine over the coach's own evidence only (origin
  PRACTICE, last 10 quizzes per topic). It never reads or writes teacher results.
- Mistakes: every wrong answer is stored with a deterministic first guess at the cause (numeric
  answer within 10 % → calculation slip; after a hint → not learned; closed question → concept
  confusion). A quiz of ≥ 80 % on the topic closes its older open mistakes.
- XP: `PRACTICE_DONE` once per quiz (`refKey coach:quiz:<id>`, workspace `coach`) — shown only on
  the student's own Growth page.
- Cap: `coach.limits.quizzesPerDay` (event `QUIZ_STARTED`) plus the monthly token and daily action
  quotas.

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

All migrations use `CREATE TABLE IF NOT EXISTS`; every identifier (tables, columns, indexes,
generated primary-key names) is at most 64 characters — `pnpm db:verify` and
`server/migrationIdentifiers.test.ts` fail otherwise.

## Errors

`COACH_NOT_AVAILABLE` (flag off), `COACH_DB_NOT_READY` (migration not applied yet),
`COACH_CONSENT_REQUIRED`, `COACH_MONTHLY_LIMIT`, `COACH_DAILY_LIMIT`, `COACH_FEATURE_LIMIT`,
`COACH_AI_BUSY` (provider rate limit), `AI_INVALID_OUTPUT`, `AI_UNAVAILABLE`.
