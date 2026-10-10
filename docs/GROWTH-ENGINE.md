# Growth Engine

Risk Radar, the topic weakness map, and the student's personal review plan with XP. Everything sits in
side tables next to Teacher → Group → Exam; no column was added to an existing busy table.

## Turning it on

Feature flag `growth_engine`, checked per workspace (`server/growth/availability.ts`):

1. env `GROWTH_ENGINE_ENABLED_WORKSPACES`: comma-separated workspace ids, or `*` for all;
2. a `feature_flag_overrides` row (`flagKey = growth_engine`, `scopeType = WORKSPACE`, `scopeId = <workspace id>`);
3. a global `feature_flags` row (`key = growth_engine`, `enabled = 1`).

An override with `enabled = 0` turns one workspace off under a global "on"; the env list always wins.
Students see the feature for the workspaces of their active groups. Inside a workspace the teacher
toggles Risk Radar, the daily digest, parent reports, and self practice per group (default off).

## Migrations

| Number | Tables |
| --- | --- |
| 0049 | `growth_dirty`, `result_topic_stats`, `topic_aliases`, `student_topic_mastery`, `assessment_origins` |
| 0050 | `growth_settings`, `student_risk`, `risk_history`, `risk_actions`, `teacher_student_notes`, `report_shares` |
| 0051 | `review_plans`, `review_plan_items`, `student_growth_settings`, `xp_events`, `student_xp`, `released_topic_levels`, `group_growth_settings` |

The numbers follow main's 0048 (group join), with later `when` values. Missing tables never break a page: the API answers
`GROWTH_DB_NOT_READY` and the background jobs skip the workspace.

## Pipeline

A finished attempt or a regraded result marks the student dirty and is processed at once; a sweeper
every two minutes reconciles whatever is left. Per student, in order (`server/growth/jobs.ts`):

1. **Topic stats** (`store.ts`): each graded question counts toward its topic key: `qt:<section>` for a
   mapped question topic, `tx:`/`sk:` for free-text topic and skill tags, `""` for untagged.
2. **Mastery** (`mastery.ts`): recency-weighted accuracy (0.7^k per older result; retakes and practice
   at 0.75), shrunk by two questions toward the student's overall accuracy. STRONG ≥ 75, REVIEW ≥ 50,
   CRITICAL below, INSUFFICIENT under three graded questions. Trend ±10 points against the mean of the
   previous two results.
4. **Released XP** (`releasedXp.ts`): level-up XP from the released results only (see XP below).
3. **Risk** (`risk.ts`, `riskStore.ts`): fixed weights in this release: score drop 30, repeated mistakes 20,
   missed exams 25, low mastery 25. HIGH ≥ 60, MEDIUM ≥ 35, WATCH ≥ 15. Every reason is stored as
   `{ code, value, points, topics? }` so the UI can say why. A dismissal holds for 14 days unless the
   score rises by 15 or more.

Daily, after 03:00 Baku: queue students with unprocessed results, recompute risk, send the teacher digest
of students who became HIGH today, roll plan steps over. Between 16:00 and 21:00 Baku: plan reminders.

## Who sees what

- **Teacher**: all results, risk score and reasons, notes, "kritik zəiflik" label.
- **Student**: released results only (`released.ts`); no risk score, no notes; the red label reads
  "Prioritet mövzu".
- **Parent report** (`/report/:token`): needs the teacher's consent setting; the token is stored hashed,
  can be revoked, and expires after 30 days. Shows released mastery and a short summary, never notes or the risk
  score. Served with `noindex` and `no-referrer`.

## Review plan

Target date: the nearest assigned exam, else the student's target exam date, else two weeks (at most six
weeks). Up to five topics with the largest expected gain. Per topic: material (20 min) and practice
(15 min), then reviews (10 min) three and seven days later; the last two days hold reviews only; a
CRITICAL topic gets a second cycle when the plan is ten days or longer. Unfinished steps roll to the
next day with room, up to three times, then they are skipped.

Self practice: when the teacher turns it on for a group, a student can start a ten-question test on a
plan topic, drawn only from exams already assigned to them; three a day. Generated tests are marked in
`assessment_origins`, are personal, and stay out of the teacher's exam list and the group analytics.

## XP

Personal only: XP, level, streak; no leaderboard. Plan step 10, practice test 20 (+10 at 70 % or more),
finished week 50, topic CRITICAL → REVIEW 30, REVIEW → STRONG 50, streak day 5.
Level = ⌊√(XP / 50)⌋. Events go to `xp_events` with a unique `(studentId, refKey)`, so a repeat never
counts twice; `student_xp` is the sum of the ledger.

Grade-dependent XP (topic level-ups, the 70 % bonus) comes only from released results
(`releasedXp.ts`), so it never gives away a grade early. `released_topic_levels` holds the levels the
student has already seen; a topic's first appearance earns nothing. The sync runs after every
recompute, in the daily pass (a closing window releases results without an event), and when the
student opens the plan.

## Notifications

| Event | To | Channels |
| --- | --- | --- |
| `GROWTH_RISK_DIGEST` | teacher | in-app, e-mail (opt-in) |
| `RETAKE_ASSIGNED` | student | in-app, push |
| `PLAN_REMINDER` | student | in-app, push; off with the plan's "Daily reminder" switch |

Dedupe keys: `growth-risk:<workspace>:<day>`, `growth-retake:<assessment>`, `growth-plan:<plan>:<day>`.
